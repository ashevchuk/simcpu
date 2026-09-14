/**
 * Minimal BASIC → Z80 bytes for Load @ / softRun.
 *
 * Supported:
 *   line numbers, LET var=expr, PRINT "str", PRINT var, GOTO n, END
 *   expr: number | var | var+number
 *
 * Vars A–Z live at 0xC00 + (ord - 'A'). PRINT writes into the text FB at 0xE00
 * via LD HL / LD (HL),A / INC HL (compile-time cursor across PRINT stmts).
 */

import { FB_BASE } from './memoryMap.js';

const VAR_BASE = 0xc00;

export function compileBasic(source: string, origin = 0x200): Uint8Array {
  const lines = parseLines(source);
  if (lines.length === 0) return new Uint8Array(0);

  // Pass 1: measure sizes so GOTO can resolve line addresses.
  const sizes = lines.map((ln) => measureStmt(ln.stmt));
  const addrOf = new Map<number, number>();
  let pc = origin & 0xffff;
  for (let i = 0; i < lines.length; i++) {
    addrOf.set(lines[i]!.num, pc);
    pc = (pc + sizes[i]!) & 0xffff;
  }

  // Pass 2: emit
  const out: number[] = [];
  let printAt = FB_BASE;
  for (const ln of lines) {
    emitStmt(ln.stmt, out, addrOf, () => {
      const a = printAt;
      printAt = (printAt + 1) & 0xffff;
      return a;
    });
  }
  return Uint8Array.from(out);
}

interface BasicLine {
  num: number;
  stmt: string;
}

function parseLines(source: string): BasicLine[] {
  const lines: BasicLine[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const t = stripComment(raw).trim();
    if (!t) continue;
    const m = /^(\d+)\s+(.+)$/.exec(t);
    if (!m) throw new Error(`BASIC: expected "N stmt", got "${t}"`);
    lines.push({ num: Number(m[1]), stmt: m[2]!.trim() });
  }
  lines.sort((a, b) => a.num - b.num);
  return lines;
}

function stripComment(s: string): string {
  // Don't strip ; inside "strings"
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"') inStr = !inStr;
    else if (!inStr && c === ';') return s.slice(0, i);
  }
  return s;
}

function varAddr(name: string): number {
  const u = name.toUpperCase();
  if (!/^[A-Z]$/.test(u)) throw new Error(`BASIC: bad var '${name}'`);
  return VAR_BASE + (u.charCodeAt(0) - 0x41);
}

function measureStmt(stmt: string): number {
  const buf: number[] = [];
  // Dummy emit with fake GOTO targets (0) — only lengths matter.
  emitStmt(
    stmt,
    buf,
    new Map(),
    (() => {
      let n = FB_BASE;
      return () => n++;
    })(),
    true,
  );
  return buf.length;
}

function emitStmt(
  stmt: string,
  out: number[],
  addrOf: Map<number, number>,
  nextFb: () => number,
  measuring = false,
): void {
  const u = stmt.toUpperCase();

  if (u === 'END') {
    out.push(0x76); // HALT
    return;
  }

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
    // LD (nn),A
    out.push(0x32, dest & 0xff, (dest >> 8) & 0xff);
    return;
  }

  if (u.startsWith('PRINT')) {
    const arg = stmt.slice(5).trim();
    if (arg.startsWith('"')) {
      const str = parseString(arg);
      if (str.length === 0) return;
      // LD HL, first cell — then LD A / LD (HL),A / INC HL per char
      const first = nextFb();
      out.push(0x21, first & 0xff, (first >> 8) & 0xff);
      for (let i = 0; i < str.length; i++) {
        if (i > 0) nextFb(); // advance compile-time cursor
        const ch = str.charCodeAt(i) & 0xff;
        out.push(0x3e, ch); // LD A,n
        out.push(0x77); // LD (HL),A
        out.push(0x23); // INC HL
      }
      return;
    }
    // PRINT var — one cell, value as raw byte
    const v = arg.trim();
    if (!/^[A-Za-z]$/.test(v)) throw new Error(`BASIC: PRINT expects string or var`);
    const src = varAddr(v);
    const cell = nextFb();
    out.push(0x3a, src & 0xff, (src >> 8) & 0xff); // LD A,(var)
    out.push(0x32, cell & 0xff, (cell >> 8) & 0xff); // LD (fb),A
    return;
  }

  throw new Error(`BASIC: unsupported '${stmt}'`);
}

function parseString(arg: string): string {
  if (!arg.startsWith('"')) throw new Error('BASIC: expected string');
  let end = 1;
  while (end < arg.length && arg[end] !== '"') end++;
  if (arg[end] !== '"') throw new Error('BASIC: unterminated string');
  const rest = arg.slice(end + 1).trim();
  if (rest !== '') throw new Error(`BASIC: junk after string: ${rest}`);
  return arg.slice(1, end);
}

/** Emit code leaving the expression value in A. */
function emitExprToA(expr: string, out: number[]): void {
  const t = expr.trim();
  // var+number
  const plus = /^([A-Za-z])\s*\+\s*(.+)$/.exec(t);
  if (plus) {
    const addr = varAddr(plus[1]!);
    const n = parseNumber(plus[2]!);
    out.push(0x3a, addr & 0xff, (addr >> 8) & 0xff); // LD A,(var)
    out.push(0xc6, n & 0xff); // ADD A,n
    return;
  }
  if (/^[A-Za-z]$/.test(t)) {
    const addr = varAddr(t);
    out.push(0x3a, addr & 0xff, (addr >> 8) & 0xff);
    return;
  }
  const n = parseNumber(t);
  out.push(0x3e, n & 0xff); // LD A,n
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
