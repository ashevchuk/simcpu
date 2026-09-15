/**
 * Mini Z80 assembler for the machine panel — subset of opcodes this sim
 * actually runs. Two-pass with labels. Not a full commercial Z80ASM.
 *
 * Numbers: 0xNN, NNh, $NN, decimal, 'A'. `$` alone = current logical PC.
 * Labels: `name:` then JR/JP/CALL/DW name.
 * Directives: DB/DEFB, DW/DEFW, EQU/DEFL name,value (or `name: EQU value`),
 * ORG n (mid-stream physical PC; output is contiguous from assemble origin to
 * max PC with 0x00 in gaps), PHASE n / DEPHASE (Z80ASM-style: labels and `$`
 * use a logical PC while bytes still emit at the physical PC; DEPHASE sets
 * logical = physical), INCLUDE "path" (via opts.readFile), MACRO name args… /
 * ENDM (macros may invoke other macros; cycles rejected; nesting ≤ 32),
 * REPT n / ENDR.
 * Expressions in immediates/EQU: `+ - * /` (integers; `*` `/` before `+ -`),
 * `HIGH FOO` / `LOW FOO` (or HIGH(FOO)/LOW(FOO)), parentheses. Labels/EQU
 * resolve in pass 2 where needed; EQU define-time uses only previously
 * defined EQU/labels.
 * Comments: `; ...` or `// ...`.
 * Index: IX/IY, (IX+d)/(IY+d), IXH/IXL/IYH/IYL remap, DD/FD CB on (IX+d).
 * CB bit/rot (incl. SLL) and common ED (blocks, ADC/SBC HL, NEG, IM, RETI, …).
 *
 * Commercial gaps (intentionally not here): local labels, relocatable object
 * files / ASEG, full undocumented DD/FD CB z≠6 dest remap, every ED corner
 * (IM vectors, I/O block flag quirks), listing pagination / cross-ref.
 */

export interface AssembleOptions {
  /** When false, skip building the text listing (bytes still assembled). Default true. */
  listing?: boolean;
  /**
   * Base directory for INCLUDE "path" resolution (joined with the quoted path).
   * Defaults to process.cwd() when available; otherwise the path is used as-is.
   */
  includeBase?: string;
  /**
   * Sync file reader for INCLUDE. Required for INCLUDE (browser/panel has none by
   * default — pass a mock in tests, or wire Node `fs.readFileSync` in CLI).
   */
  readFile?: (path: string) => string;
}

export interface AssembleResult {
  ok: boolean;
  bytes: Uint8Array;
  errors: string[];
  /** One line per emitted instruction: `0100  3e 41     LD A,41h` */
  listing: string[];
  origin: number;
}

const R8: Record<string, number> = { b: 0, c: 1, d: 2, e: 3, h: 4, l: 5, a: 7 };
const HLMEM = 6;
const DD: Record<string, number> = { bc: 0, de: 1, hl: 2, sp: 3 };
const QQ: Record<string, number> = { bc: 0, de: 1, hl: 2, af: 3 };
const CC: Record<string, number> = {
  nz: 0,
  z: 1,
  nc: 2,
  c: 3,
  po: 4,
  pe: 5,
  p: 6,
  m: 7,
};
const ALU: Record<string, number> = {
  add: 0,
  adc: 1,
  sub: 2,
  sbc: 3,
  and: 4,
  xor: 5,
  or: 6,
  cp: 7,
};
const JR_CC: Record<string, number> = { nz: 0, z: 1, nc: 2, c: 3 };

/** CB x=00 rotates/shifts (y). SLL is undocumented (y=6, bit0 forced 1). */
const CB_ROT: Record<string, number> = {
  rlc: 0,
  rrc: 1,
  rl: 2,
  rr: 3,
  sla: 4,
  sra: 5,
  sll: 6,
  srl: 7,
};

type DbPart = { kind: 'str'; data: number[] } | { kind: 'expr'; expr: string };

type Emit =
  | { kind: 'bytes'; data: number[]; text: string; line: number; addr: number }
  | { kind: 'db'; parts: DbPart[]; text: string; line: number; addr: number }
  | {
      kind: 'rel';
      op: number;
      target: string;
      text: string;
      line: number;
      addr: number;
      /** Logical PC at emit (PHASE); used for relative displacement. */
      logicalAddr: number;
    }
  | { kind: 'abs'; opcode: number[]; target: string; text: string; line: number; addr: number }
  | {
      kind: 'imm8';
      opcode: number[];
      expr: string;
      text: string;
      line: number;
      addr: number;
      logicalAddr: number;
    };

interface LineTok {
  lineNo: number;
  label?: string;
  mnemonic?: string;
  args: string[];
  raw: string;
}

interface MacroDef {
  args: string[];
  body: LineTok[];
}

interface IndexDisp {
  pref: 0xdd | 0xfd;
  d: number;
}

/** Remapped H/L under DD/FD: IXH/IXL/IYH/IYL. */
interface IndexHalf {
  pref: 0xdd | 0xfd;
  r: 4 | 5; // H or L slot
}

export function assemble(source: string, origin = 0, opts: AssembleOptions = {}): AssembleResult {
  const wantListing = opts.listing !== false;
  const errors: string[] = [];
  const labels = new Map<string, number>();
  const equ = new Map<string, number>();
  const emits: Emit[] = [];
  const baseOrigin = origin & 0xffff;
  /** Physical emit cursor (where bytes land in the output image). */
  let physPc = baseOrigin;
  /** Logical PC for labels / `$` (PHASE overlay; equals physPc outside PHASE). */
  let logPc = baseOrigin;
  let inPhase = false;

  let lines: LineTok[];
  try {
    lines = expandSource(source, opts, errors);
  } catch (e) {
    return {
      ok: false,
      bytes: new Uint8Array(0),
      errors: [`${e instanceof Error ? e.message : String(e)}`],
      listing: [],
      origin: baseOrigin,
    };
  }

  for (const ln of lines) {
    const mn = ln.mnemonic?.toLowerCase();
    if (mn === 'equ' || mn === 'defl') {
      try {
        defineEqu(ln, equ, labels, logPc);
      } catch (e) {
        errors.push(`L${ln.lineNo}: ${e instanceof Error ? e.message : String(e)}`);
      }
      continue;
    }
    if (mn === 'org') {
      try {
        if (ln.args.length !== 1) throw new Error('ORG needs address');
        const n = evalExpr(ln.args[0]!, equ, labels, logPc);
        if (n < baseOrigin) throw new Error(`ORG ${n} is before assemble origin ${baseOrigin}`);
        physPc = n & 0xffff;
        if (!inPhase) logPc = physPc;
      } catch (e) {
        errors.push(`L${ln.lineNo}: ${e instanceof Error ? e.message : String(e)}`);
      }
      continue;
    }
    if (mn === 'phase') {
      try {
        if (ln.args.length !== 1) throw new Error('PHASE needs address');
        const n = evalExpr(ln.args[0]!, equ, labels, logPc);
        logPc = n & 0xffff;
        inPhase = true;
      } catch (e) {
        errors.push(`L${ln.lineNo}: ${e instanceof Error ? e.message : String(e)}`);
      }
      continue;
    }
    if (mn === 'dephase') {
      if (ln.args.length !== 0) {
        errors.push(`L${ln.lineNo}: DEPHASE takes no arguments`);
      } else {
        logPc = physPc;
        inPhase = false;
      }
      continue;
    }
    if (ln.label) {
      const key = ln.label.toLowerCase();
      if (labels.has(key) || equ.has(key)) errors.push(`L${ln.lineNo}: duplicate label '${ln.label}'`);
      else labels.set(key, logPc);
    }
    if (!ln.mnemonic) continue;
    try {
      const emit = encode(ln, equ, labels, physPc, logPc);
      emits.push(emit);
      const sz = emitSize(emit);
      physPc = (physPc + sz) & 0xffff;
      logPc = (logPc + sz) & 0xffff;
    } catch (e) {
      errors.push(`L${ln.lineNo}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let maxPc = baseOrigin;
  for (const em of emits) {
    const end = em.addr + emitSize(em);
    if (end > maxPc) maxPc = end;
  }
  if (physPc > maxPc) maxPc = physPc;

  const span = Math.max(0, Math.min(0x10000, maxPc) - baseOrigin);
  const out = new Uint8Array(span);
  const listing: string[] = [];

  for (const em of emits) {
    try {
      const data = materialize(em, labels, equ);
      const off = em.addr - baseOrigin;
      if (off < 0 || off + data.length > out.length) {
        throw new Error(`emit address 0x${em.addr.toString(16)} out of output span`);
      }
      out.set(data, off);
      if (wantListing && data.length > 0) {
        const hex = data.map((b) => b.toString(16).padStart(2, '0')).join(' ');
        listing.push(`${fmtAddr(em.addr)}  ${hex.padEnd(12)}  ${em.text}`);
      }
    } catch (e) {
      errors.push(`L${em.line}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    ok: errors.length === 0,
    bytes: out,
    errors,
    listing,
    origin: baseOrigin,
  };
}

/** Expand INCLUDE, then MACRO/REPT into a flat line list. */
function expandSource(source: string, opts: AssembleOptions, errors: string[]): LineTok[] {
  const withIncludes = expandIncludes(source, opts, new Set(), 0);
  return expandMacrosAndRept(withIncludes, errors);
}

function expandIncludes(
  source: string,
  opts: AssembleOptions,
  seen: Set<string>,
  depth: number,
): LineTok[] {
  if (depth > 32) throw new Error('INCLUDE nesting too deep');
  const rawLines = tokenize(source);
  const out: LineTok[] = [];
  for (const ln of rawLines) {
    const mn = ln.mnemonic?.toLowerCase();
    if (mn !== 'include') {
      out.push(ln);
      continue;
    }
    if (ln.args.length !== 1) throw new Error(`L${ln.lineNo}: INCLUDE needs "path"`);
    const pathArg = ln.args[0]!;
    const m = /^"(.*)"$/.exec(pathArg) ?? /^'(.*)'$/.exec(pathArg);
    if (!m) throw new Error(`L${ln.lineNo}: INCLUDE path must be quoted`);
    const rel = m[1]!;
    if (!opts.readFile) {
      throw new Error(`L${ln.lineNo}: INCLUDE requires opts.readFile (not available in browser)`);
    }
    const full = joinIncludePath(opts.includeBase, rel);
    const key = full.toLowerCase();
    if (seen.has(key)) throw new Error(`L${ln.lineNo}: recursive INCLUDE '${rel}'`);
    seen.add(key);
    let text: string;
    try {
      text = opts.readFile(full);
    } catch (e) {
      throw new Error(
        `L${ln.lineNo}: INCLUDE failed to read '${full}': ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const nested = expandIncludes(text, opts, seen, depth + 1);
    seen.delete(key);
    out.push(...nested);
  }
  return out;
}

function joinIncludePath(base: string | undefined, rel: string): string {
  if (/^([a-zA-Z]:)?[/\\]/.test(rel)) return rel;
  const b =
    base ??
    (typeof process !== 'undefined' && typeof process.cwd === 'function' ? process.cwd() : '');
  if (!b) return rel;
  const sep = b.includes('\\') && !b.includes('/') ? '\\' : '/';
  return b.replace(/[/\\]+$/, '') + sep + rel.replace(/^[/\\]+/, '');
}

function expandMacrosAndRept(lines: LineTok[], errors: string[]): LineTok[] {
  const macros = new Map<string, MacroDef>();
  const stripped: LineTok[] = [];
  for (let i = 0; i < lines.length; ) {
    const ln = lines[i]!;
    const mn = ln.mnemonic?.toLowerCase();
    if (mn === 'macro') {
      try {
        const { name, def, next } = parseMacroDef(lines, i);
        if (macros.has(name)) throw new Error(`duplicate MACRO '${name}'`);
        macros.set(name, def);
        i = next;
      } catch (e) {
        errors.push(`L${ln.lineNo}: ${e instanceof Error ? e.message : String(e)}`);
        i++;
      }
      continue;
    }
    stripped.push(ln);
    i++;
  }

  const equ = new Map<string, number>();
  const labels = new Map<string, number>();
  return expandBody(stripped, macros, equ, labels, errors, 0, []);
}

function parseMacroDef(
  lines: LineTok[],
  start: number,
): { name: string; def: MacroDef; next: number } {
  const ln = lines[start]!;
  // `MACRO name arg1,arg2` — name is space-separated from formals (not a comma).
  const header = ln.args.join(',');
  const hm = /^([A-Za-z_][\w]*)\s*(.*)$/.exec(header.trim());
  if (!hm) throw new Error('MACRO needs a name');
  const name = hm[1]!.toLowerCase();
  const formals = hm[2]!.trim() ? splitArgs(hm[2]!.trim()) : [];
  const body: LineTok[] = [];
  let i = start + 1;
  let depth = 1;
  while (i < lines.length) {
    const cur = lines[i]!;
    const mn = cur.mnemonic?.toLowerCase();
    if (mn === 'macro') depth++;
    if (mn === 'endm') {
      depth--;
      if (depth === 0) return { name, def: { args: formals, body }, next: i + 1 };
    }
    body.push(cur);
    i++;
  }
  throw new Error('MACRO without ENDM');
}

const MACRO_EXPAND_MAX_DEPTH = 32;

function expandBody(
  lines: LineTok[],
  macros: Map<string, MacroDef>,
  equ: Map<string, number>,
  labels: Map<string, number>,
  errors: string[],
  depth: number,
  expanding: string[],
): LineTok[] {
  if (depth > MACRO_EXPAND_MAX_DEPTH) {
    throw new Error(`macro/REPT expansion too deep (max ${MACRO_EXPAND_MAX_DEPTH})`);
  }
  const out: LineTok[] = [];
  for (let i = 0; i < lines.length; ) {
    const ln = lines[i]!;
    const mn = ln.mnemonic?.toLowerCase();

    if (mn === 'rept') {
      try {
        if (ln.args.length !== 1) throw new Error('REPT needs count');
        const n = evalExpr(ln.args[0]!, equ, labels);
        if (n < 0 || n > 4096) throw new Error(`REPT count out of range (${n})`);
        const { body, next } = collectUntil(lines, i + 1, 'endr', 'rept');
        const expandedBody = expandBody(body, macros, equ, labels, errors, depth + 1, expanding);
        for (let r = 0; r < n; r++) out.push(...cloneLines(expandedBody));
        i = next;
      } catch (e) {
        errors.push(`L${ln.lineNo}: ${e instanceof Error ? e.message : String(e)}`);
        i++;
      }
      continue;
    }

    if (mn === 'equ' || mn === 'defl') {
      try {
        defineEqu(ln, equ, labels);
      } catch {
        /* assembly pass will report */
      }
      out.push(ln);
      i++;
      continue;
    }

    if (mn && macros.has(mn)) {
      try {
        if (expanding.includes(mn)) {
          throw new Error(`recursive MACRO '${mn}' (${[...expanding, mn].join(' → ')})`);
        }
        const def = macros.get(mn)!;
        if (ln.args.length !== def.args.length) {
          throw new Error(`MACRO ${mn} expects ${def.args.length} arg(s), got ${ln.args.length}`);
        }
        const subst = substituteMacro(def, ln.args, ln.lineNo);
        const expanded = expandBody(
          subst,
          macros,
          equ,
          labels,
          errors,
          depth + 1,
          [...expanding, mn],
        );
        if (ln.label && expanded.length > 0) {
          expanded[0] = { ...expanded[0]!, label: expanded[0]!.label ?? ln.label };
        } else if (ln.label) {
          out.push({ lineNo: ln.lineNo, label: ln.label, args: [], raw: ln.raw });
        }
        out.push(...expanded);
      } catch (e) {
        errors.push(`L${ln.lineNo}: ${e instanceof Error ? e.message : String(e)}`);
      }
      i++;
      continue;
    }

    out.push(ln);
    i++;
  }
  return out;
}

function collectUntil(
  lines: LineTok[],
  start: number,
  endMn: string,
  nestMn: string,
): { body: LineTok[]; next: number } {
  const body: LineTok[] = [];
  let depth = 1;
  let i = start;
  while (i < lines.length) {
    const cur = lines[i]!;
    const mn = cur.mnemonic?.toLowerCase();
    if (mn === nestMn) depth++;
    if (mn === endMn) {
      depth--;
      if (depth === 0) return { body, next: i + 1 };
    }
    body.push(cur);
    i++;
  }
  throw new Error(`${nestMn.toUpperCase()} without ${endMn.toUpperCase()}`);
}

function substituteMacro(def: MacroDef, actuals: string[], lineNo: number): LineTok[] {
  return def.body.map((ln) => {
    let label = ln.label;
    if (label) label = substIdents(label, def.args, actuals);
    let mnemonic = ln.mnemonic;
    if (mnemonic) mnemonic = substIdents(mnemonic, def.args, actuals);
    const args = ln.args.map((a) => substIdents(a, def.args, actuals));
    const head = label ? `${label}: ` : '';
    const rest = mnemonic ? `${mnemonic}${args.length ? ' ' + args.join(',') : ''}` : '';
    return {
      lineNo,
      label,
      mnemonic: mnemonic?.toLowerCase(),
      args,
      raw: (head + rest).trim() || ln.raw,
    };
  });
}

/** Replace formal arg identifiers with actuals (word-boundary, case-insensitive). */
function substIdents(text: string, formals: string[], actuals: string[]): string {
  let s = text;
  for (let i = 0; i < formals.length; i++) {
    const f = formals[i]!;
    const a = actuals[i]!;
    const re = new RegExp(`\\b${escapeRegExp(f)}\\b`, 'gi');
    s = s.replace(re, a);
  }
  return s;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cloneLines(lines: LineTok[]): LineTok[] {
  return lines.map((l) => ({ ...l, args: [...l.args] }));
}

/** EQU/DEFL name,value — or `name: EQU value` (label is the symbol). */
function defineEqu(
  ln: LineTok,
  equ: Map<string, number>,
  labels: Map<string, number>,
  here?: number,
): void {
  let name: string;
  let valArg: string;
  if (ln.label && ln.args.length === 1) {
    name = ln.label;
    valArg = ln.args[0]!;
  } else if (ln.args.length === 2) {
    name = ln.args[0]!;
    valArg = ln.args[1]!;
  } else {
    throw new Error('EQU/DEFL needs name,value (or name: EQU value)');
  }
  if (!/^[A-Za-z_][\w]*$/.test(name)) throw new Error(`bad EQU name '${name}'`);
  const n = evalExpr(valArg, equ, labels, here);
  const key = name.toLowerCase();
  if (equ.has(key) || labels.has(key)) throw new Error(`duplicate EQU '${name}'`);
  equ.set(key, n & 0xffff);
}

function emitSize(em: Emit): number {
  if (em.kind === 'bytes') return em.data.length;
  if (em.kind === 'db') {
    let n = 0;
    for (const p of em.parts) n += p.kind === 'str' ? p.data.length : 1;
    return n;
  }
  if (em.kind === 'rel') return 2;
  if (em.kind === 'imm8') return em.opcode.length + 1;
  return em.opcode.length + 2;
}

function materialize(em: Emit, labels: Map<string, number>, equ: Map<string, number>): number[] {
  if (em.kind === 'bytes') return em.data;
  if (em.kind === 'db') {
    const data: number[] = [];
    for (const p of em.parts) {
      if (p.kind === 'str') {
        data.push(...p.data);
      } else {
        const n = evalExpr(p.expr, equ, labels);
        if (n < 0 || n > 0xff) throw new Error(`bad DB byte '${p.expr}'`);
        data.push(n & 0xff);
      }
    }
    return data;
  }
  if (em.kind === 'rel') {
    const target = evalExpr(em.target, equ, labels);
    const next = (em.logicalAddr + 2) & 0xffff;
    let disp = target - next;
    if (disp < -128 || disp > 127) {
      throw new Error(`relative jump out of range to '${em.target}' (${disp})`);
    }
    if (disp < 0) disp += 256;
    return [em.op, disp & 0xff];
  }
  if (em.kind === 'imm8') {
    const n = evalExpr(em.expr, equ, labels, em.logicalAddr);
    if (n < 0 || n > 0xff) throw new Error(`imm8 out of range '${em.expr}' (${n})`);
    return [...em.opcode, n & 0xff];
  }
  const target = evalExpr(em.target, equ, labels);
  return [...em.opcode, target & 0xff, (target >> 8) & 0xff];
}

/**
 * Evaluate an expression: literals, labels/EQU, `$` (logical PC), + - * /,
 * HIGH/LOW, parentheses. Integers only; `*` `/` bind tighter than `+` `-`.
 */
function evalExpr(
  src: string,
  equ: Map<string, number>,
  labels: Map<string, number>,
  here?: number,
): number {
  const s = src.trim();
  if (!s) throw new Error('empty expression');
  let i = 0;

  function peek(): string {
    return s[i] ?? '';
  }
  function skipWs(): void {
    while (i < s.length && /\s/.test(s[i]!)) i++;
  }
  function matchIdent(): string | null {
    skipWs();
    const m = /^[A-Za-z_][\w]*/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  }

  function parsePrimary(): number {
    skipWs();
    const save = i;
    const kw = matchIdent();
    if (kw) {
      const k = kw.toUpperCase();
      if (k === 'HIGH' || k === 'LOW') {
        skipWs();
        let inner: number;
        if (peek() === '(') {
          i++;
          inner = parseAdd();
          skipWs();
          if (peek() !== ')') throw new Error(`expected ')' in ${k}()`);
          i++;
        } else {
          inner = parsePrimary();
        }
        return k === 'HIGH' ? (inner >> 8) & 0xff : inner & 0xff;
      }
      i = save;
    }

    skipWs();
    if (peek() === '(') {
      i++;
      const v = parseAdd();
      skipWs();
      if (peek() !== ')') throw new Error("expected ')'");
      i++;
      return v & 0xffff;
    }

    if (peek() === "'") {
      if (i + 2 < s.length && s[i + 2] === "'") {
        const c = s.charCodeAt(i + 1);
        i += 3;
        return c;
      }
    }

    // Bare `$` = current logical PC; `$NN` remains hex immediate.
    if (peek() === '$') {
      const hexAfter = /^\$[0-9a-fA-F]+/i.exec(s.slice(i));
      if (!hexAfter) {
        i++;
        if (here === undefined) throw new Error("'$' requires a current PC");
        return here & 0xffff;
      }
    }

    const numMatch =
      /^(0x[0-9a-fA-F]+|\$[0-9a-fA-F]+|[0-9a-fA-F]+h|[0-9]+)/i.exec(s.slice(i));
    if (numMatch) {
      const tok = numMatch[0]!;
      const next = s[i + tok.length];
      // Don't treat the "CH" prefix of CHAR as a hex-h number.
      if (!(next && /[A-Za-z0-9_]/.test(next))) {
        i += tok.length;
        const n = parseImm(tok);
        if (n === null) throw new Error(`bad number '${tok}'`);
        return n;
      }
    }

    const id = matchIdent();
    if (id) {
      const key = id.toLowerCase();
      if (equ.has(key)) return equ.get(key)! & 0xffff;
      if (labels.has(key)) return labels.get(key)! & 0xffff;
      throw new Error(`unknown symbol '${id}'`);
    }

    throw new Error(`bad expression near '${s.slice(i)}'`);
  }

  function parseUnary(): number {
    skipWs();
    if (peek() === '+') {
      i++;
      return parseUnary() & 0xffff;
    }
    if (peek() === '-') {
      i++;
      return (-parseUnary()) & 0xffff;
    }
    return parsePrimary();
  }

  function parseMul(): number {
    let v = parseUnary();
    for (;;) {
      skipWs();
      if (peek() === '*') {
        i++;
        v = (v * parseUnary()) & 0xffff;
        continue;
      }
      if (peek() === '/') {
        i++;
        const d = parseUnary();
        if (d === 0) throw new Error('division by zero');
        v = (Math.trunc(v / d) & 0xffff);
        continue;
      }
      break;
    }
    return v & 0xffff;
  }

  function parseAdd(): number {
    let v = parseMul();
    for (;;) {
      skipWs();
      if (peek() === '+') {
        i++;
        v = (v + parseMul()) & 0xffff;
        continue;
      }
      if (peek() === '-') {
        i++;
        v = (v - parseMul()) & 0xffff;
        continue;
      }
      break;
    }
    return v & 0xffff;
  }

  const result = parseAdd();
  skipWs();
  if (i < s.length) throw new Error(`trailing junk in expression '${s}'`);
  return result & 0xffff;
}

/**
 * Try to resolve an expression with current equ/labels.
 * Returns null if an unknown symbol is needed (defer to pass 2).
 * Throws on syntax errors.
 */
function tryEvalExpr(
  src: string,
  equ: Map<string, number>,
  labels: Map<string, number>,
  here?: number,
): number | null {
  try {
    return evalExpr(src, equ, labels, here);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/unknown symbol/i.test(msg)) return null;
    throw e;
  }
}

function tokenize(source: string): LineTok[] {
  const out: LineTok[] = [];
  for (const [i, raw] of source.split(/\r?\n/).entries()) {
    const lineNo = i + 1;
    let s = raw.replace(/\/\/.*$/, '').replace(/;.*$/, '').trim();
    if (!s) continue;
    let label: string | undefined;
    const labelMatch = /^([A-Za-z_][\w]*):\s*(.*)$/.exec(s);
    if (labelMatch) {
      label = labelMatch[1];
      s = labelMatch[2]!.trim();
    }
    if (!s) {
      out.push({ lineNo, label, args: [], raw: raw.trim() });
      continue;
    }
    const m = /^([A-Za-z.]+)\s*(.*)$/.exec(s);
    if (!m) continue;
    const mnemonic = m[1]!.toLowerCase();
    const argStr = m[2]!.trim();
    out.push({
      lineNo,
      label,
      mnemonic,
      args: argStr ? splitArgs(argStr) : [],
      raw: raw.trim(),
    });
  }
  return out;
}

function splitArgs(s: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  for (const ch of s) {
    if (inStr) {
      cur += ch;
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      cur += ch;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function encode(
  ln: LineTok,
  equ: Map<string, number>,
  labels: Map<string, number>,
  addr: number,
  logicalAddr: number,
): Emit {
  const m = ln.mnemonic!;
  const a = ln.args;
  const text = ln.raw;
  const line = ln.lineNo;
  const imm = (s: string) => tryEvalExpr(s, equ, labels, logicalAddr);

  if (m === 'db' || m === 'defb') {
    const parts: DbPart[] = [];
    let allResolved = true;
    for (const arg of a) {
      if (arg.startsWith('"') && arg.endsWith('"')) {
        const data: number[] = [];
        for (let j = 1; j < arg.length - 1; j++) data.push(arg.charCodeAt(j) & 0xff);
        parts.push({ kind: 'str', data });
        continue;
      }
      const n = imm(arg);
      if (n !== null) {
        if (n < 0 || n > 0xff) throw new Error(`bad DB byte '${arg}'`);
        parts.push({ kind: 'str', data: [n] });
      } else {
        allResolved = false;
        parts.push({ kind: 'expr', expr: arg });
      }
    }
    if (allResolved) {
      const data: number[] = [];
      for (const p of parts) if (p.kind === 'str') data.push(...p.data);
      return { kind: 'bytes', data, text, line, addr };
    }
    return { kind: 'db', parts, text, line, addr };
  }

  if (m === 'dw' || m === 'defw') {
    if (a.length === 1) {
      const n = imm(a[0]!);
      if (n !== null) {
        return { kind: 'bytes', data: [n & 0xff, (n >> 8) & 0xff], text, line, addr };
      }
      return { kind: 'abs', opcode: [], target: a[0]!, text, line, addr };
    }
    const data: number[] = [];
    for (const arg of a) {
      const n = imm(arg);
      if (n === null) throw new Error(`DW label must be alone: '${arg}'`);
      data.push(n & 0xff, (n >> 8) & 0xff);
    }
    return { kind: 'bytes', data, text, line, addr };
  }

  const simple: Record<string, number[]> = {
    nop: [0x00],
    halt: [0x76],
    di: [0xf3],
    ei: [0xfb],
    exx: [0xd9],
    rlca: [0x07],
    rrca: [0x0f],
    rla: [0x17],
    rra: [0x1f],
    daa: [0x27],
    cpl: [0x2f],
    scf: [0x37],
    ccf: [0x3f],
    neg: [0xed, 0x44],
    reti: [0xed, 0x4d],
    retn: [0xed, 0x45],
    ldi: [0xed, 0xa0],
    ldd: [0xed, 0xa8],
    ldir: [0xed, 0xb0],
    lddr: [0xed, 0xb8],
    cpi: [0xed, 0xa1],
    cpd: [0xed, 0xa9],
    cpir: [0xed, 0xb1],
    cpdr: [0xed, 0xb9],
    ini: [0xed, 0xa2],
    ind: [0xed, 0xaa],
    inir: [0xed, 0xb2],
    indr: [0xed, 0xba],
    outi: [0xed, 0xa3],
    outd: [0xed, 0xab],
    otir: [0xed, 0xb3],
    otdr: [0xed, 0xbb],
    rld: [0xed, 0x6f],
    rrd: [0xed, 0x67],
  };
  if (m in simple && a.length === 0) return immBytes(simple[m]!, text, line, addr);

  if (m === 'im') {
    const n = imm(a[0] ?? '');
    if (n === 0) return immBytes([0xed, 0x46], text, line, addr);
    if (n === 1) return immBytes([0xed, 0x56], text, line, addr);
    if (n === 2) return immBytes([0xed, 0x5e], text, line, addr);
    throw new Error('IM 0/1/2');
  }

  if (m === 'ex') {
    const x = norm(a[0] ?? '');
    const y = norm(a[1] ?? '');
    if (x === 'de' && y === 'hl') return immBytes([0xeb], text, line, addr);
    if (x === 'af' && (y === "af'" || y === 'af')) return immBytes([0x08], text, line, addr);
    if (x === '(sp)' && y === 'hl') return immBytes([0xe3], text, line, addr);
    if (x === '(sp)' && y === 'ix') return immBytes([0xdd, 0xe3], text, line, addr);
    if (x === '(sp)' && y === 'iy') return immBytes([0xfd, 0xe3], text, line, addr);
    throw new Error(`unsupported EX ${a.join(',')}`);
  }

  if (m === 'ret') {
    if (a.length === 0) return immBytes([0xc9], text, line, addr);
    const cc = CC[norm(a[0]!)];
    if (cc === undefined) throw new Error(`bad RET cc '${a[0]}'`);
    return immBytes([0xc0 | (cc << 3)], text, line, addr);
  }

  if (m === 'rst') {
    const n = imm(a[0] ?? '');
    if (n === null || (n & 7) !== 0 || n > 0x38) throw new Error(`bad RST '${a[0]}'`);
    return immBytes([0xc7 | n], text, line, addr);
  }

  if (m === 'push' || m === 'pop') {
    const q = norm(a[0] ?? '');
    if (q === 'ix') return immBytes([0xdd, m === 'push' ? 0xe5 : 0xe1], text, line, addr);
    if (q === 'iy') return immBytes([0xfd, m === 'push' ? 0xe5 : 0xe1], text, line, addr);
    const qq = QQ[q];
    if (qq === undefined) throw new Error(`bad ${m.toUpperCase()} '${a[0]}'`);
    return immBytes([(m === 'push' ? 0xc5 : 0xc1) | (qq << 4)], text, line, addr);
  }

  if (m === 'djnz') {
    if (a.length !== 1) throw new Error('DJNZ target');
    return { kind: 'rel', op: 0x10, target: a[0]!, text, line, addr, logicalAddr };
  }

  if (m === 'jr') {
    if (a.length === 1) {
      return { kind: 'rel', op: 0x18, target: a[0]!, text, line, addr, logicalAddr };
    }
    if (a.length === 2) {
      const cc = JR_CC[norm(a[0]!)];
      if (cc === undefined) throw new Error('JR cc must be NZ/Z/NC/C');
      return {
        kind: 'rel',
        op: 0x20 | (cc << 3),
        target: a[1]!,
        text,
        line,
        addr,
        logicalAddr,
      };
    }
    throw new Error('JR syntax');
  }

  if (m === 'jp') {
    if (a.length === 1) {
      const t = norm(a[0]!);
      if (t === '(hl)') return immBytes([0xe9], text, line, addr);
      if (t === '(ix)') return immBytes([0xdd, 0xe9], text, line, addr);
      if (t === '(iy)') return immBytes([0xfd, 0xe9], text, line, addr);
      return { kind: 'abs', opcode: [0xc3], target: a[0]!, text, line, addr };
    }
    if (a.length === 2) {
      const cc = CC[norm(a[0]!)];
      if (cc === undefined) throw new Error(`bad JP cc '${a[0]}'`);
      return { kind: 'abs', opcode: [0xc2 | (cc << 3)], target: a[1]!, text, line, addr };
    }
    throw new Error('JP syntax');
  }

  if (m === 'call') {
    if (a.length === 1) return { kind: 'abs', opcode: [0xcd], target: a[0]!, text, line, addr };
    if (a.length === 2) {
      const cc = CC[norm(a[0]!)];
      if (cc === undefined) throw new Error(`bad CALL cc '${a[0]}'`);
      return { kind: 'abs', opcode: [0xc4 | (cc << 3)], target: a[1]!, text, line, addr };
    }
    throw new Error('CALL syntax');
  }

  if (m === 'in') {
    if (a.length === 2 && norm(a[0]!) === 'a' && isParen(a[1]!)) {
      return emitImm8(
        [0xdb],
        stripParens(a[1]!),
        text,
        line,
        addr,
        equ,
        labels,
        'bad IN port',
        logicalAddr,
      );
    }
    if (a.length === 2 && isParen(a[1]!) && norm(stripParens(a[1]!)) === 'c') {
      const r = parseR8(a[0]!);
      if (r === null || r === HLMEM) throw new Error('IN r,(C)');
      return immBytes([0xed, 0x40 | (r << 3)], text, line, addr);
    }
    throw new Error('only IN A,(n) / IN r,(C) supported');
  }
  if (m === 'out') {
    if (a.length === 2 && isParen(a[0]!) && norm(a[1]!) === 'a') {
      return emitImm8(
        [0xd3],
        stripParens(a[0]!),
        text,
        line,
        addr,
        equ,
        labels,
        'bad OUT port',
        logicalAddr,
      );
    }
    if (a.length === 2 && isParen(a[0]!) && norm(stripParens(a[0]!)) === 'c') {
      const r = parseR8(a[1]!);
      if (r === null || r === HLMEM) throw new Error('OUT (C),r');
      return immBytes([0xed, 0x41 | (r << 3)], text, line, addr);
    }
    throw new Error('only OUT (n),A / OUT (C),r supported');
  }

  if (m === 'bit' || m === 'set' || m === 'res') {
    if (a.length !== 2) throw new Error(`${m.toUpperCase()} bit,op`);
    const bit = imm(a[0]!);
    if (bit === null || bit < 0 || bit > 7) throw new Error('bit 0..7');
    const x = m === 'bit' ? 1 : m === 'res' ? 2 : 3;
    const op = (x << 6) | (bit << 3);
    return encodeCbOp(op, a[1]!, text, line, addr);
  }
  if (m in CB_ROT) {
    if (a.length !== 1) throw new Error(`${m.toUpperCase()} op`);
    const op = CB_ROT[m]! << 3;
    return encodeCbOp(op, a[0]!, text, line, addr);
  }

  if (m in ALU) {
    const y = ALU[m]!;
    if (m === 'add' && a.length === 2) {
      const d0 = norm(a[0]!);
      if (d0 === 'hl') {
        const dd = DD[norm(a[1]!)];
        if (dd === undefined) throw new Error('ADD HL,rr');
        return immBytes([0x09 | (dd << 4)], text, line, addr);
      }
      if (d0 === 'ix' || d0 === 'iy') {
        const pref = d0 === 'ix' ? 0xdd : 0xfd;
        const rr = indexPairRr(a[1]!, d0);
        return immBytes([pref, 0x09 | (rr << 4)], text, line, addr);
      }
    }
    if ((m === 'adc' || m === 'sbc') && a.length === 2 && norm(a[0]!) === 'hl') {
      const dd = DD[norm(a[1]!)];
      if (dd === undefined) throw new Error(`${m.toUpperCase()} HL,rr`);
      const base = m === 'adc' ? 0x4a : 0x42;
      return immBytes([0xed, base | (dd << 4)], text, line, addr);
    }
    const op = a.length === 2 && norm(a[0]!) === 'a' ? a[1]! : a.length === 1 ? a[0]! : null;
    if (!op) throw new Error(`${m.toUpperCase()} syntax`);
    const idx = parseIndexDisp(op);
    if (idx) return immBytes([idx.pref, 0x80 | (y << 3) | HLMEM, idx.d], text, line, addr);
    const half = parseIndexHalf(op);
    if (half) return immBytes([half.pref, 0x80 | (y << 3) | half.r], text, line, addr);
    const r = parseR8(op);
    if (r !== null) return immBytes([0x80 | (y << 3) | r], text, line, addr);
    return emitImm8(
      [0xc6 | (y << 3)],
      op,
      text,
      line,
      addr,
      equ,
      labels,
      `bad ${m.toUpperCase()} operand`,
      logicalAddr,
    );
  }

  if (m === 'inc' || m === 'dec') {
    if (a.length !== 1) throw new Error(`${m.toUpperCase()} needs one operand`);
    const inc = m === 'inc';
    const t = norm(a[0]!);
    if (t === 'ix') return immBytes([0xdd, inc ? 0x23 : 0x2b], text, line, addr);
    if (t === 'iy') return immBytes([0xfd, inc ? 0x23 : 0x2b], text, line, addr);
    const idx = parseIndexDisp(a[0]!);
    if (idx) return immBytes([idx.pref, inc ? 0x34 : 0x35, idx.d], text, line, addr);
    const half = parseIndexHalf(a[0]!);
    if (half) return immBytes([half.pref, (inc ? 0x04 : 0x05) | (half.r << 3)], text, line, addr);
    const dd = DD[t];
    if (dd !== undefined) return immBytes([(inc ? 0x03 : 0x0b) | (dd << 4)], text, line, addr);
    const r = parseR8(a[0]!);
    if (r !== null) return immBytes([(inc ? 0x04 : 0x05) | (r << 3)], text, line, addr);
    throw new Error(`bad ${m.toUpperCase()} '${a[0]}'`);
  }

  if (m === 'ld') {
    if (a.length !== 2) throw new Error('LD needs two operands');
    return encodeLd(a[0]!, a[1]!, text, line, equ, labels, addr, logicalAddr);
  }

  throw new Error(`unsupported mnemonic '${m}'`);
}

function emitImm8(
  opcode: number[],
  expr: string,
  text: string,
  line: number,
  addr: number,
  equ: Map<string, number>,
  labels: Map<string, number>,
  rangeErr: string,
  here?: number,
): Emit {
  const n = tryEvalExpr(expr, equ, labels, here);
  if (n !== null) {
    if (n < 0 || n > 0xff) throw new Error(rangeErr);
    return immBytes([...opcode, n], text, line, addr);
  }
  return { kind: 'imm8', opcode, expr, text, line, addr, logicalAddr: here ?? addr };
}

function encodeCbOp(opBase: number, operand: string, text: string, line: number, addr: number): Emit {
  const idx = parseIndexDisp(operand);
  if (idx) {
    return immBytes([idx.pref, 0xcb, idx.d, opBase | HLMEM], text, line, addr);
  }
  const r = parseR8(operand);
  if (r === null) throw new Error(`bad CB operand '${operand}'`);
  return immBytes([0xcb, opBase | r], text, line, addr);
}

function encodeLd(
  dst: string,
  src: string,
  text: string,
  line: number,
  equ: Map<string, number>,
  labels: Map<string, number>,
  addr: number,
  logicalAddr: number,
): Emit {
  const d = norm(dst);
  const s = norm(src);
  const imm = (x: string) => tryEvalExpr(x, equ, labels, logicalAddr);

  if (d === 'a' && s === 'i') return immBytes([0xed, 0x57], text, line, addr);
  if (d === 'a' && s === 'r') return immBytes([0xed, 0x5f], text, line, addr);
  if (d === 'i' && s === 'a') return immBytes([0xed, 0x47], text, line, addr);
  if (d === 'r' && s === 'a') return immBytes([0xed, 0x4f], text, line, addr);

  if (d === 'sp' && s === 'hl') return immBytes([0xf9], text, line, addr);
  if (d === 'sp' && s === 'ix') return immBytes([0xdd, 0xf9], text, line, addr);
  if (d === 'sp' && s === 'iy') return immBytes([0xfd, 0xf9], text, line, addr);

  if (d === 'ix' || d === 'iy') {
    const pref = d === 'ix' ? 0xdd : 0xfd;
    if (isAbsMem(src)) return { kind: 'abs', opcode: [pref, 0x2a], target: stripParens(src), text, line, addr };
    const ni = imm(src);
    if (ni !== null) {
      return immBytes([pref, 0x21, ni & 0xff, (ni >> 8) & 0xff], text, line, addr);
    }
    return { kind: 'abs', opcode: [pref, 0x21], target: src, text, line, addr };
  }
  if ((s === 'ix' || s === 'iy') && isAbsMem(dst)) {
    const pref = s === 'ix' ? 0xdd : 0xfd;
    return { kind: 'abs', opcode: [pref, 0x22], target: stripParens(dst), text, line, addr };
  }

  const dd = DD[d];
  if (dd !== undefined && !isParen(dst)) {
    if (isAbsMem(src)) {
      if (d === 'hl') return { kind: 'abs', opcode: [0x2a], target: stripParens(src), text, line, addr };
      return { kind: 'abs', opcode: [0xed, 0x4b | (dd << 4)], target: stripParens(src), text, line, addr };
    }
    const ni = imm(src);
    if (ni !== null) {
      return immBytes([0x01 | (dd << 4), ni & 0xff, (ni >> 8) & 0xff], text, line, addr);
    }
    return { kind: 'abs', opcode: [0x01 | (dd << 4)], target: src, text, line, addr };
  }

  if (isAbsMem(dst) && !isParen(src)) {
    const ss = DD[s];
    if (ss !== undefined) {
      if (s === 'hl') return { kind: 'abs', opcode: [0x22], target: stripParens(dst), text, line, addr };
      return { kind: 'abs', opcode: [0xed, 0x43 | (ss << 4)], target: stripParens(dst), text, line, addr };
    }
  }

  if (isAbsMem(dst) && s === 'a') {
    return { kind: 'abs', opcode: [0x32], target: stripParens(dst), text, line, addr };
  }
  if (d === 'a' && isAbsMem(src)) {
    return { kind: 'abs', opcode: [0x3a], target: stripParens(src), text, line, addr };
  }

  if (d === '(bc)' && s === 'a') return immBytes([0x02], text, line, addr);
  if (d === 'a' && s === '(bc)') return immBytes([0x0a], text, line, addr);
  if (d === '(de)' && s === 'a') return immBytes([0x12], text, line, addr);
  if (d === 'a' && s === '(de)') return immBytes([0x1a], text, line, addr);

  const dstIdx = parseIndexDisp(dst);
  const srcIdx = parseIndexDisp(src);
  if (dstIdx && srcIdx) throw new Error('LD (IX+d),(IY+d) illegal');
  if (dstIdx) {
    const n = imm(src);
    if (n !== null && n <= 0xff) return immBytes([dstIdx.pref, 0x36, dstIdx.d, n], text, line, addr);
    if (n === null && looksLikeExpr(src) && parseR8(src) === null) {
      return {
        kind: 'imm8',
        opcode: [dstIdx.pref, 0x36, dstIdx.d],
        expr: src,
        text,
        line,
        addr,
        logicalAddr,
      };
    }
    const r = parseR8(src);
    if (r !== null && r !== HLMEM) return immBytes([dstIdx.pref, 0x70 | r, dstIdx.d], text, line, addr);
    throw new Error('LD (IX+d),op');
  }
  if (srcIdx) {
    const r = parseR8(dst);
    if (r !== null && r !== HLMEM) {
      return immBytes([srcIdx.pref, 0x40 | (r << 3) | HLMEM, srcIdx.d], text, line, addr);
    }
    throw new Error('LD r,(IX+d)');
  }

  if (d === '(hl)') {
    const n = imm(src);
    if (n !== null && n <= 0xff) return immBytes([0x36, n], text, line, addr);
    if (n === null && looksLikeExpr(src) && parseR8(src) === null) {
      return { kind: 'imm8', opcode: [0x36], expr: src, text, line, addr, logicalAddr };
    }
    const r = parseR8(src);
    if (r !== null && r !== HLMEM) return immBytes([0x70 | r], text, line, addr);
    throw new Error('LD (HL),op');
  }
  if (s === '(hl)') {
    const r = parseR8(dst);
    if (r !== null && r !== HLMEM) return immBytes([0x40 | (r << 3) | HLMEM], text, line, addr);
  }

  const dh = parseIndexHalf(dst);
  const sh = parseIndexHalf(src);
  if (dh || sh) {
    const pref = (dh ?? sh)!.pref;
    if (dh && sh && dh.pref !== sh.pref) throw new Error('mixed IX/IY halves');
    if (dh && sh) return immBytes([pref, 0x40 | (dh.r << 3) | sh.r], text, line, addr);
    if (dh) {
      const n = imm(src);
      if (n !== null && n <= 0xff) return immBytes([pref, 0x06 | (dh.r << 3), n], text, line, addr);
      if (n === null && looksLikeExpr(src) && parseR8(src) === null) {
        return {
          kind: 'imm8',
          opcode: [pref, 0x06 | (dh.r << 3)],
          expr: src,
          text,
          line,
          addr,
          logicalAddr,
        };
      }
      const rs = parseR8(src);
      if (rs !== null && rs !== HLMEM) return immBytes([pref, 0x40 | (dh.r << 3) | rs], text, line, addr);
    }
    if (sh) {
      const rd = parseR8(dst);
      if (rd !== null && rd !== HLMEM) return immBytes([pref, 0x40 | (rd << 3) | sh.r], text, line, addr);
    }
    throw new Error(`unsupported LD ${dst},${src}`);
  }

  const rd = parseR8(dst);
  if (rd !== null && rd !== HLMEM) {
    const n = imm(src);
    if (n !== null && n <= 0xff) return immBytes([0x06 | (rd << 3), n], text, line, addr);
    if (n === null && looksLikeExpr(src) && parseR8(src) === null) {
      return { kind: 'imm8', opcode: [0x06 | (rd << 3)], expr: src, text, line, addr, logicalAddr };
    }
    const rs = parseR8(src);
    if (rs !== null) return immBytes([0x40 | (rd << 3) | rs], text, line, addr);
  }

  throw new Error(`unsupported LD ${dst},${src}`);
}

/** Heuristic: operand looks like an expression / symbol, not a register. */
function looksLikeExpr(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (t === '$') return true;
  if (/^[A-Za-z_][\w]*$/.test(t)) return true;
  if (/^(HIGH|LOW)\b/i.test(t)) return true;
  if (/[+\-*/]/.test(t)) return true;
  if (t.startsWith('(') && t.endsWith(')')) return true;
  return parseImm(t) !== null;
}

/** ADD IX,rr — rr is BC/DE/IX/SP (IY for ADD IY). */
function indexPairRr(arg: string, self: 'ix' | 'iy'): number {
  const t = norm(arg);
  if (t === 'bc') return 0;
  if (t === 'de') return 1;
  if (t === self) return 2;
  if (t === 'sp') return 3;
  throw new Error(`ADD ${self.toUpperCase()},rr`);
}

function parseIndexHalf(s: string): IndexHalf | null {
  const n = norm(s);
  if (n === 'ixh') return { pref: 0xdd, r: 4 };
  if (n === 'ixl') return { pref: 0xdd, r: 5 };
  if (n === 'iyh') return { pref: 0xfd, r: 4 };
  if (n === 'iyl') return { pref: 0xfd, r: 5 };
  return null;
}

/** Parse (IX+d) / (IY-d) / (IX) / (IY). */
function parseIndexDisp(s: string): IndexDisp | null {
  if (!isParen(s)) return null;
  const inner = stripParens(s);
  const m = /^(ix|iy)\s*([+-]\s*.+)?$/i.exec(inner);
  if (!m) return null;
  const pref: 0xdd | 0xfd = m[1]!.toLowerCase() === 'ix' ? 0xdd : 0xfd;
  if (!m[2]) return { pref, d: 0 };
  const expr = m[2].replace(/\s+/g, '');
  const sign = expr[0] === '-' ? -1 : 1;
  const num = parseImm(expr.slice(1));
  if (num === null || num > 0xff) throw new Error(`bad displacement '${s}'`);
  let d = sign * num;
  if (d < -128 || d > 127) throw new Error(`displacement out of range '${s}'`);
  if (d < 0) d += 256;
  return { pref, d };
}

function immBytes(data: number[], text: string, line: number, addr: number): Emit {
  return { kind: 'bytes', data, text, line, addr };
}

function parseR8(s: string): number | null {
  const n = norm(s);
  if (n === '(hl)') return HLMEM;
  return R8[n] ?? null;
}

export function parseImm(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  if (t.length === 3 && t[0] === "'" && t[2] === "'") return t.charCodeAt(1);
  if (/^0x[0-9a-fA-F]+$/.test(t)) return parseInt(t.slice(2), 16);
  if (/^\$[0-9a-fA-F]+$/.test(t)) return parseInt(t.slice(1), 16);
  if (/^[0-9a-fA-F]+h$/i.test(t)) return parseInt(t.slice(0, -1), 16);
  if (/^[0-9]+$/.test(t)) return parseInt(t, 10);
  return null;
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '');
}

function isParen(s: string): boolean {
  const t = s.trim();
  return t.startsWith('(') && t.endsWith(')');
}

function isAbsMem(s: string): boolean {
  if (!isParen(s)) return false;
  const inner = stripParens(s);
  if (/^(ix|iy)\b/i.test(inner.trim())) return false;
  if (['hl', 'bc', 'de', 'sp'].includes(norm(inner))) return false;
  // Allow expressions / symbols inside absolute memory operands.
  if (parseImm(inner) !== null) return true;
  if (/^[A-Za-z_][\w]*$/.test(inner.trim())) return true;
  if (/[+\-*/]|(HIGH|LOW)\b|\$/i.test(inner)) return true;
  return false;
}

function stripParens(s: string): string {
  const t = s.trim();
  if (t.startsWith('(') && t.endsWith(')')) return t.slice(1, -1).trim();
  return t;
}

function fmtAddr(addr: number): string {
  return (addr & 0xffff).toString(16).padStart(4, '0');
}

/** Format assembled bytes as comma-hex for the Load box. Optional space every `group` bytes. */
export function bytesToHexPrompt(bytes: Uint8Array, group = 0): string {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
  if (group <= 0) return hex.join(',');
  const parts: string[] = [];
  for (let i = 0; i < hex.length; i += group) {
    parts.push(hex.slice(i, i + group).join(','));
  }
  return parts.join(' ');
}
