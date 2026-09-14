/**
 * Mini Z80 assembler for the machine panel — subset of opcodes this sim
 * actually runs. Two-pass with labels. Not a full assembler.
 *
 * Numbers: 0xNN, NNh, $NN, decimal, 'A'. Labels: `name:` then JR/JP/CALL/DW name.
 * Directives: DB/DEFB, DW/DEFW. Comments: `; ...` or `// ...`.
 */

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

type Emit =
  | { kind: 'bytes'; data: number[]; text: string; line: number }
  | { kind: 'rel'; op: number; target: string; text: string; line: number }
  | { kind: 'abs'; opcode: number[]; target: string; text: string; line: number };

interface LineTok {
  lineNo: number;
  label?: string;
  mnemonic?: string;
  args: string[];
  raw: string;
}

export function assemble(source: string, origin = 0): AssembleResult {
  const errors: string[] = [];
  const lines = tokenize(source);
  const labels = new Map<string, number>();
  const emits: Emit[] = [];
  let pc = origin & 0xffff;

  for (const ln of lines) {
    if (ln.label) {
      const key = ln.label.toLowerCase();
      if (labels.has(key)) errors.push(`L${ln.lineNo}: duplicate label '${ln.label}'`);
      else labels.set(key, pc);
    }
    if (!ln.mnemonic) continue;
    try {
      const emit = encode(ln);
      emits.push(emit);
      pc = (pc + emitSize(emit)) & 0xffff;
    } catch (e) {
      errors.push(`L${ln.lineNo}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const out: number[] = [];
  const listing: string[] = [];
  pc = origin & 0xffff;
  for (const em of emits) {
    const start = pc;
    try {
      const data = materialize(em, pc, labels);
      out.push(...data);
      pc = (pc + data.length) & 0xffff;
      if (data.length > 0) {
        const hex = data.map((b) => b.toString(16).padStart(2, '0')).join(' ');
        listing.push(`${fmtAddr(start)}  ${hex.padEnd(12)}  ${em.text}`);
      }
    } catch (e) {
      errors.push(`L${em.line}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    ok: errors.length === 0,
    bytes: Uint8Array.from(out),
    errors,
    listing,
    origin: origin & 0xffff,
  };
}

function emitSize(em: Emit): number {
  if (em.kind === 'bytes') return em.data.length;
  if (em.kind === 'rel') return 2;
  return em.opcode.length + 2;
}

function materialize(em: Emit, pc: number, labels: Map<string, number>): number[] {
  if (em.kind === 'bytes') return em.data;
  if (em.kind === 'rel') {
    const target = resolve(em.target, labels);
    const next = (pc + 2) & 0xffff;
    let disp = target - next;
    if (disp < -128 || disp > 127) throw new Error(`relative jump out of range to '${em.target}' (${disp})`);
    if (disp < 0) disp += 256;
    return [em.op, disp & 0xff];
  }
  const target = resolve(em.target, labels);
  return [...em.opcode, target & 0xff, (target >> 8) & 0xff];
}

function resolve(name: string, labels: Map<string, number>): number {
  const n = parseImm(name);
  if (n !== null) return n & 0xffff;
  const addr = labels.get(name.toLowerCase());
  if (addr === undefined) throw new Error(`unknown label '${name}'`);
  return addr;
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
  for (const ch of s) {
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

function encode(ln: LineTok): Emit {
  const m = ln.mnemonic!;
  const a = ln.args;
  const text = ln.raw;
  const line = ln.lineNo;

  if (m === 'db' || m === 'defb') {
    const data: number[] = [];
    for (const arg of a) {
      if (arg.startsWith('"') && arg.endsWith('"')) {
        for (let i = 1; i < arg.length - 1; i++) data.push(arg.charCodeAt(i) & 0xff);
        continue;
      }
      const n = parseImm(arg);
      if (n === null || n < 0 || n > 0xff) throw new Error(`bad DB byte '${arg}'`);
      data.push(n);
    }
    return { kind: 'bytes', data, text, line };
  }

  if (m === 'dw' || m === 'defw') {
    if (a.length === 1 && parseImm(a[0]!) === null) {
      return { kind: 'abs', opcode: [], target: a[0]!, text, line };
    }
    const data: number[] = [];
    for (const arg of a) {
      const n = parseImm(arg);
      if (n === null) throw new Error(`DW label must be alone: '${arg}'`);
      data.push(n & 0xff, (n >> 8) & 0xff);
    }
    return { kind: 'bytes', data, text, line };
  }

  const simple: Record<string, number> = {
    nop: 0x00,
    halt: 0x76,
    di: 0xf3,
    ei: 0xfb,
    exx: 0xd9,
    rlca: 0x07,
    rrca: 0x0f,
    rla: 0x17,
    rra: 0x1f,
    daa: 0x27,
    cpl: 0x2f,
    scf: 0x37,
    ccf: 0x3f,
  };
  if (m in simple && a.length === 0) return immBytes([simple[m]!], text, line);

  if (m === 'ex') {
    const x = norm(a[0] ?? '');
    const y = norm(a[1] ?? '');
    if (x === 'de' && y === 'hl') return immBytes([0xeb], text, line);
    if (x === 'af' && (y === "af'" || y === 'af')) return immBytes([0x08], text, line);
    if (x === '(sp)' && y === 'hl') return immBytes([0xe3], text, line);
    throw new Error(`unsupported EX ${a.join(',')}`);
  }

  if (m === 'ret') {
    if (a.length === 0) return immBytes([0xc9], text, line);
    const cc = CC[norm(a[0]!)];
    if (cc === undefined) throw new Error(`bad RET cc '${a[0]}'`);
    return immBytes([0xc0 | (cc << 3)], text, line);
  }

  if (m === 'rst') {
    const n = parseImm(a[0] ?? '');
    if (n === null || (n & 7) !== 0 || n > 0x38) throw new Error(`bad RST '${a[0]}'`);
    return immBytes([0xc7 | n], text, line);
  }

  if (m === 'push' || m === 'pop') {
    const qq = QQ[norm(a[0] ?? '')];
    if (qq === undefined) throw new Error(`bad ${m.toUpperCase()} '${a[0]}'`);
    return immBytes([(m === 'push' ? 0xc5 : 0xc1) | (qq << 4)], text, line);
  }

  if (m === 'djnz') {
    if (a.length !== 1) throw new Error('DJNZ target');
    return { kind: 'rel', op: 0x10, target: a[0]!, text, line };
  }

  if (m === 'jr') {
    if (a.length === 1) return { kind: 'rel', op: 0x18, target: a[0]!, text, line };
    if (a.length === 2) {
      const cc = JR_CC[norm(a[0]!)];
      if (cc === undefined) throw new Error('JR cc must be NZ/Z/NC/C');
      return { kind: 'rel', op: 0x20 | (cc << 3), target: a[1]!, text, line };
    }
    throw new Error('JR syntax');
  }

  if (m === 'jp') {
    if (a.length === 1) {
      if (norm(a[0]!) === '(hl)') return immBytes([0xe9], text, line);
      return { kind: 'abs', opcode: [0xc3], target: a[0]!, text, line };
    }
    if (a.length === 2) {
      const cc = CC[norm(a[0]!)];
      if (cc === undefined) throw new Error(`bad JP cc '${a[0]}'`);
      return { kind: 'abs', opcode: [0xc2 | (cc << 3)], target: a[1]!, text, line };
    }
    throw new Error('JP syntax');
  }

  if (m === 'call') {
    if (a.length === 1) return { kind: 'abs', opcode: [0xcd], target: a[0]!, text, line };
    if (a.length === 2) {
      const cc = CC[norm(a[0]!)];
      if (cc === undefined) throw new Error(`bad CALL cc '${a[0]}'`);
      return { kind: 'abs', opcode: [0xc4 | (cc << 3)], target: a[1]!, text, line };
    }
    throw new Error('CALL syntax');
  }

  if (m === 'in') {
    if (a.length === 2 && norm(a[0]!) === 'a' && isParen(a[1]!)) {
      const n = parseImm(stripParens(a[1]!));
      if (n === null || n > 0xff) throw new Error('bad IN port');
      return immBytes([0xdb, n], text, line);
    }
    throw new Error('only IN A,(n) supported');
  }
  if (m === 'out') {
    if (a.length === 2 && isParen(a[0]!) && norm(a[1]!) === 'a') {
      const n = parseImm(stripParens(a[0]!));
      if (n === null || n > 0xff) throw new Error('bad OUT port');
      return immBytes([0xd3, n], text, line);
    }
    throw new Error('only OUT (n),A supported');
  }

  if (m in ALU) {
    const y = ALU[m]!;
    if (m === 'add' && a.length === 2 && norm(a[0]!) === 'hl') {
      const dd = DD[norm(a[1]!)];
      if (dd === undefined) throw new Error('ADD HL,rr');
      return immBytes([0x09 | (dd << 4)], text, line);
    }
    const op = a.length === 2 && norm(a[0]!) === 'a' ? a[1]! : a.length === 1 ? a[0]! : null;
    if (!op) throw new Error(`${m.toUpperCase()} syntax`);
    const r = parseR8(op);
    if (r !== null) return immBytes([0x80 | (y << 3) | r], text, line);
    const n = parseImm(op);
    if (n !== null && n <= 0xff) return immBytes([0xc6 | (y << 3), n], text, line);
    throw new Error(`bad ${m.toUpperCase()} operand`);
  }

  if (m === 'inc' || m === 'dec') {
    if (a.length !== 1) throw new Error(`${m.toUpperCase()} needs one operand`);
    const inc = m === 'inc';
    const dd = DD[norm(a[0]!)];
    if (dd !== undefined) return immBytes([(inc ? 0x03 : 0x0b) | (dd << 4)], text, line);
    const r = parseR8(a[0]!);
    if (r !== null) return immBytes([(inc ? 0x04 : 0x05) | (r << 3)], text, line);
    throw new Error(`bad ${m.toUpperCase()} '${a[0]}'`);
  }

  if (m === 'ld') {
    if (a.length !== 2) throw new Error('LD needs two operands');
    return encodeLd(a[0]!, a[1]!, text, line);
  }

  throw new Error(`unsupported mnemonic '${m}'`);
}

function encodeLd(dst: string, src: string, text: string, line: number): Emit {
  const d = norm(dst);
  const s = norm(src);

  if (d === 'sp' && s === 'hl') return immBytes([0xf9], text, line);

  const dd = DD[d];
  if (dd !== undefined && !isParen(dst)) {
    if (parseImm(src) !== null) {
      const n = parseImm(src)!;
      return immBytes([0x01 | (dd << 4), n & 0xff, (n >> 8) & 0xff], text, line);
    }
    return { kind: 'abs', opcode: [0x01 | (dd << 4)], target: src, text, line };
  }

  if (isAbsMem(dst) && s === 'hl') return { kind: 'abs', opcode: [0x22], target: stripParens(dst), text, line };
  if (d === 'hl' && isAbsMem(src)) return { kind: 'abs', opcode: [0x2a], target: stripParens(src), text, line };
  if (isAbsMem(dst) && s === 'a') return { kind: 'abs', opcode: [0x32], target: stripParens(dst), text, line };
  if (d === 'a' && isAbsMem(src)) return { kind: 'abs', opcode: [0x3a], target: stripParens(src), text, line };

  if (d === '(bc)' && s === 'a') return immBytes([0x02], text, line);
  if (d === 'a' && s === '(bc)') return immBytes([0x0a], text, line);
  if (d === '(de)' && s === 'a') return immBytes([0x12], text, line);
  if (d === 'a' && s === '(de)') return immBytes([0x1a], text, line);

  if (d === '(hl)') {
    const n = parseImm(src);
    if (n !== null && n <= 0xff) return immBytes([0x36, n], text, line);
    const r = parseR8(src);
    if (r !== null && r !== HLMEM) return immBytes([0x70 | r], text, line);
    throw new Error('LD (HL),op');
  }
  if (s === '(hl)') {
    const r = parseR8(dst);
    if (r !== null && r !== HLMEM) return immBytes([0x40 | (r << 3) | HLMEM], text, line);
  }

  const rd = parseR8(dst);
  if (rd !== null && rd !== HLMEM) {
    const n = parseImm(src);
    if (n !== null && n <= 0xff) return immBytes([0x06 | (rd << 3), n], text, line);
    const rs = parseR8(src);
    if (rs !== null) return immBytes([0x40 | (rd << 3) | rs], text, line);
  }

  throw new Error(`unsupported LD ${dst},${src}`);
}

function immBytes(data: number[], text: string, line: number): Emit {
  return { kind: 'bytes', data, text, line };
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
  if (['hl', 'bc', 'de', 'ix', 'iy', 'sp'].includes(norm(inner))) return false;
  return parseImm(inner) !== null || /^[A-Za-z_][\w]*$/.test(inner.trim());
}

function stripParens(s: string): string {
  const t = s.trim();
  if (t.startsWith('(') && t.endsWith(')')) return t.slice(1, -1).trim();
  return t;
}

function fmtAddr(addr: number): string {
  return (addr & 0xffff).toString(16).padStart(4, '0');
}

/** Format assembled bytes as comma-hex for the Load box. */
export function bytesToHexPrompt(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(',');
}
