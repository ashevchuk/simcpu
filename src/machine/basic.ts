/**
 * Minimal BASIC → Z80 bytes for Load @ / softRun.
 *
 * Supported:
 *   line numbers, LET var=expr, PRINT items, GOTO n, END, REM
 *   IF cond THEN line  (cond: var op number; op = <> < > <= >=)
 *   FOR var=a TO b / NEXT var  (non-nested)
 *   INPUT var — busy-wait KEY_STATUS / KEY_DATA (0xF00 / 0xF01)
 *   expr: number | var | var+number
 *
 * Vars A–Z live at 0xC00 + (ord - 'A'). PRINT writes into the text FB at 0xE00
 * via LD HL / LD (HL),A / INC HL (compile-time cursor across PRINT stmts).
 * PRINT separators: `;` no space, `,` one space (tab-ish).
 */

import { FB_BASE, KEY_DATA, KEY_STATUS } from './memoryMap.js';

const VAR_BASE = 0xc00;

export function compileBasic(source: string, origin = 0x200): Uint8Array {
  const lines = parseLines(source);
  if (lines.length === 0) return new Uint8Array(0);

  const sizes = lines.map((ln) => measureStmt(ln.stmt));
  const addrOf = new Map<number, number>();
  let pc = origin & 0xffff;
  for (let i = 0; i < lines.length; i++) {
    addrOf.set(lines[i]!.num, pc);
    pc = (pc + sizes[i]!) & 0xffff;
  }

  const out: number[] = [];
  let printAt = FB_BASE;
  const forStack: ForFrame[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    const nextLineAddr =
      i + 1 < lines.length
        ? addrOf.get(lines[i + 1]!.num)!
        : (origin + sizes.reduce((a, b) => a + b, 0)) & 0xffff;
    emitStmt(
      ln.stmt,
      out,
      addrOf,
      () => {
        const a = printAt;
        printAt = (printAt + 1) & 0xffff;
        return a;
      },
      false,
      forStack,
      nextLineAddr,
    );
  }
  if (forStack.length > 0) throw new Error('BASIC: FOR without NEXT');
  return Uint8Array.from(out);
}

interface BasicLine {
  num: number;
  stmt: string;
}

interface ForFrame {
  varName: string;
  limit: number;
  loopAddr: number;
}

function parseLines(source: string): BasicLine[] {
  const lines: BasicLine[] = [];
  for (const raw of source.split(/\r?\n/)) {
    // Comments are REM only — do not strip `;` (PRINT uses it as a separator).
    const t = raw.trim();
    if (!t) continue;
    const m = /^(\d+)\s+(.+)$/.exec(t);
    if (!m) throw new Error(`BASIC: expected "N stmt", got "${t}"`);
    lines.push({ num: Number(m[1]), stmt: m[2]!.trim() });
  }
  lines.sort((a, b) => a.num - b.num);
  return lines;
}

function varAddr(name: string): number {
  const u = name.toUpperCase();
  if (!/^[A-Z]$/.test(u)) throw new Error(`BASIC: bad var '${name}'`);
  return VAR_BASE + (u.charCodeAt(0) - 0x41);
}

function measureStmt(stmt: string): number {
  const buf: number[] = [];
  emitStmt(
    stmt,
    buf,
    new Map(),
    (() => {
      let n = FB_BASE;
      return () => n++;
    })(),
    true,
    [],
    0,
  );
  return buf.length;
}

function emitStmt(
  stmt: string,
  out: number[],
  addrOf: Map<number, number>,
  nextFb: () => number,
  measuring = false,
  forStack: ForFrame[] = [],
  nextLineAddr = 0,
): void {
  const u = stmt.toUpperCase();

  if (u === 'END') {
    out.push(0x76);
    return;
  }

  if (u.startsWith('REM')) return;

  if (u.startsWith('GOTO')) {
    const n = Number(stmt.slice(4).trim());
    if (!Number.isFinite(n)) throw new Error(`BASIC: bad GOTO '${stmt}'`);
    const tgt = measuring ? 0 : addrOf.get(n);
    if (tgt === undefined) throw new Error(`BASIC: GOTO ${n} — missing line`);
    out.push(0xc3, tgt & 0xff, (tgt >> 8) & 0xff);
    return;
  }

  if (u.startsWith('LET')) {
    const body = stmt.slice(3).trim();
    const eq = body.indexOf('=');
    if (eq < 0) throw new Error(`BASIC: LET needs '='`);
    const v = body.slice(0, eq).trim();
    const expr = body.slice(eq + 1).trim();
    const dest = varAddr(v);
    emitExprToA(expr, out);
    out.push(0x32, dest & 0xff, (dest >> 8) & 0xff);
    return;
  }

  if (u.startsWith('IF')) {
    emitIf(stmt, out, addrOf, measuring);
    return;
  }

  if (u.startsWith('FOR')) {
    emitFor(stmt, out, forStack, nextLineAddr, measuring);
    return;
  }

  if (u.startsWith('NEXT')) {
    emitNext(stmt, out, forStack, measuring);
    return;
  }

  if (u.startsWith('INPUT')) {
    emitInput(stmt.slice(5).trim(), out);
    return;
  }

  if (u.startsWith('PRINT')) {
    emitPrint(stmt.slice(5).trim(), out, nextFb);
    return;
  }

  throw new Error(`BASIC: unsupported '${stmt}'`);
}

/** IF var op number THEN line */
function emitIf(stmt: string, out: number[], addrOf: Map<number, number>, measuring: boolean): void {
  const m = /^IF\s+(.+?)\s+THEN\s+(\d+)\s*$/i.exec(stmt);
  if (!m) throw new Error(`BASIC: bad IF '${stmt}'`);
  const cmp = parseCond(m[1]!.trim());
  const thenLine = Number(m[2]);
  const tgt = measuring ? 0 : addrOf.get(thenLine);
  if (tgt === undefined) throw new Error(`BASIC: IF THEN ${thenLine} — missing line`);

  const addr = varAddr(cmp.varName);
  out.push(0x3a, addr & 0xff, (addr >> 8) & 0xff); // LD A,(var)
  out.push(0xfe, cmp.n & 0xff); // CP n

  // CP flags: Z if A==n, C if A<n (unsigned).
  switch (cmp.op) {
    case '=':
      out.push(0xca, tgt & 0xff, (tgt >> 8) & 0xff); // JP Z
      break;
    case '<>':
      out.push(0xc2, tgt & 0xff, (tgt >> 8) & 0xff); // JP NZ
      break;
    case '<':
      out.push(0xda, tgt & 0xff, (tgt >> 8) & 0xff); // JP C
      break;
    case '>=':
      out.push(0xd2, tgt & 0xff, (tgt >> 8) & 0xff); // JP NC
      break;
    case '<=':
      out.push(0xca, tgt & 0xff, (tgt >> 8) & 0xff); // JP Z
      out.push(0xda, tgt & 0xff, (tgt >> 8) & 0xff); // JP C
      break;
    case '>':
      // A > n ⇔ ¬Z ∧ ¬C: JR Z,end / JR C,end / JP tgt / end:
      out.push(0x28, 5); // JR Z, +5
      out.push(0x38, 3); // JR C, +3
      out.push(0xc3, tgt & 0xff, (tgt >> 8) & 0xff);
      break;
    default:
      throw new Error(`BASIC: bad IF op '${cmp.op}'`);
  }
}

function parseCond(cond: string): { varName: string; op: string; n: number } {
  const m = /^([A-Za-z])\s*(<>|<=|>=|=|<|>)\s*(.+)$/.exec(cond.trim());
  if (!m) throw new Error(`BASIC: bad IF condition '${cond}'`);
  return { varName: m[1]!, op: m[2]!, n: parseNumber(m[3]!) };
}

function emitFor(
  stmt: string,
  out: number[],
  forStack: ForFrame[],
  nextLineAddr: number,
  measuring: boolean,
): void {
  const m = /^FOR\s+([A-Za-z])\s*=\s*(.+?)\s+TO\s+(.+)$/i.exec(stmt.trim());
  if (!m) throw new Error(`BASIC: bad FOR '${stmt}'`);
  if (!measuring && forStack.length > 0) throw new Error('BASIC: nested FOR not supported');
  const varName = m[1]!;
  const dest = varAddr(varName);
  emitExprToA(m[2]!.trim(), out);
  out.push(0x32, dest & 0xff, (dest >> 8) & 0xff);
  if (!measuring) {
    forStack.push({
      varName: varName.toUpperCase(),
      limit: parseNumber(m[3]!),
      loopAddr: nextLineAddr,
    });
  }
}

function emitNext(stmt: string, out: number[], forStack: ForFrame[], measuring: boolean): void {
  const m = /^NEXT\s+([A-Za-z])\s*$/i.exec(stmt.trim());
  if (!m) throw new Error(`BASIC: bad NEXT '${stmt}'`);
  const varName = m[1]!.toUpperCase();
  const dest = varAddr(varName);
  let loopAddr = 0;
  let limit = 0;
  if (!measuring) {
    if (forStack.length === 0) throw new Error('BASIC: NEXT without FOR');
    const fr = forStack.pop()!;
    if (fr.varName !== varName) throw new Error(`BASIC: NEXT ${varName} mismatches FOR ${fr.varName}`);
    loopAddr = fr.loopAddr;
    limit = fr.limit;
  }
  // LD A,(var) / CP limit / JR Z,done / INC A / LD (var),A / JP loop / done:
  out.push(0x3a, dest & 0xff, (dest >> 8) & 0xff);
  out.push(0xfe, limit & 0xff);
  out.push(0x28, 7); // JR Z, +7
  out.push(0x3c); // INC A
  out.push(0x32, dest & 0xff, (dest >> 8) & 0xff);
  out.push(0xc3, loopAddr & 0xff, (loopAddr >> 8) & 0xff);
}

function emitInput(varName: string, out: number[]): void {
  const v = varName.trim();
  if (!/^[A-Za-z]$/.test(v)) throw new Error(`BASIC: INPUT expects var`);
  const dest = varAddr(v);
  // wait: LD A,(KEY_STATUS) / OR A / JR Z,wait / LD A,(KEY_DATA) / LD (var),A
  out.push(0x3a, KEY_STATUS & 0xff, (KEY_STATUS >> 8) & 0xff);
  out.push(0xb7);
  out.push(0x28, 0xfa); // JR Z, -6 → back to wait
  out.push(0x3a, KEY_DATA & 0xff, (KEY_DATA >> 8) & 0xff);
  out.push(0x32, dest & 0xff, (dest >> 8) & 0xff);
}

function emitPrint(arg: string, out: number[], nextFb: () => number): void {
  if (!arg) return;
  for (const item of splitPrintItems(arg)) {
    if (item.kind === 'space') {
      const cell = nextFb();
      out.push(0x21, cell & 0xff, (cell >> 8) & 0xff);
      out.push(0x3e, 0x20);
      out.push(0x77);
      out.push(0x23);
      continue;
    }
    if (item.kind === 'str') {
      if (item.value.length === 0) continue;
      const first = nextFb();
      out.push(0x21, first & 0xff, (first >> 8) & 0xff);
      for (let i = 0; i < item.value.length; i++) {
        if (i > 0) nextFb();
        out.push(0x3e, item.value.charCodeAt(i) & 0xff);
        out.push(0x77);
        out.push(0x23);
      }
      continue;
    }
    const src = varAddr(item.value);
    const cell = nextFb();
    out.push(0x3a, src & 0xff, (src >> 8) & 0xff);
    out.push(0x32, cell & 0xff, (cell >> 8) & 0xff);
  }
}

type PrintItem =
  | { kind: 'str'; value: string }
  | { kind: 'var'; value: string }
  | { kind: 'space' };

function splitPrintItems(arg: string): PrintItem[] {
  const items: PrintItem[] = [];
  const pushExpr = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    if (t.startsWith('"')) {
      items.push({ kind: 'str', value: parseStringOnly(t) });
      return;
    }
    if (!/^[A-Za-z]$/.test(t)) throw new Error(`BASIC: PRINT expects string or var, got '${t}'`);
    items.push({ kind: 'var', value: t });
  };

  let cur = '';
  let inStr = false;
  for (let i = 0; i < arg.length; i++) {
    const c = arg[i]!;
    if (c === '"') {
      inStr = !inStr;
      cur += c;
      continue;
    }
    if (!inStr && (c === ';' || c === ',')) {
      pushExpr(cur);
      cur = '';
      if (c === ',') items.push({ kind: 'space' });
      continue;
    }
    cur += c;
  }
  pushExpr(cur);
  return items;
}

function parseStringOnly(arg: string): string {
  if (!arg.startsWith('"')) throw new Error('BASIC: expected string');
  let end = 1;
  while (end < arg.length && arg[end] !== '"') end++;
  if (arg[end] !== '"') throw new Error('BASIC: unterminated string');
  const rest = arg.slice(end + 1).trim();
  if (rest !== '') throw new Error(`BASIC: junk after string: ${rest}`);
  return arg.slice(1, end);
}

function emitExprToA(expr: string, out: number[]): void {
  const t = expr.trim();
  const plus = /^([A-Za-z])\s*\+\s*(.+)$/.exec(t);
  if (plus) {
    const addr = varAddr(plus[1]!);
    const n = parseNumber(plus[2]!);
    out.push(0x3a, addr & 0xff, (addr >> 8) & 0xff);
    out.push(0xc6, n & 0xff);
    return;
  }
  if (/^[A-Za-z]$/.test(t)) {
    const addr = varAddr(t);
    out.push(0x3a, addr & 0xff, (addr >> 8) & 0xff);
    return;
  }
  const n = parseNumber(t);
  out.push(0x3e, n & 0xff);
}

function parseNumber(s: string): number {
  const t = s.trim().toLowerCase();
  let n: number;
  if (t.startsWith('0x')) n = parseInt(t, 16);
  else if (t.endsWith('h')) n = parseInt(t.slice(0, -1), 16);
  else n = parseInt(t, 10);
  if (!Number.isFinite(n) || n < 0 || n > 0xff) throw new Error(`BASIC: bad number '${s}'`);
  return n;
}
