/**
 * Mini Z80 assembler for the machine panel — subset of opcodes this sim
 * actually runs. Two-pass with labels. Not a full commercial Z80ASM.
 *
 * Numbers: 0xNN, NNh, $NN, decimal, 'A'. Labels: `name:` then JR/JP/CALL/DW name.
 * Directives: DB/DEFB, DW/DEFW. Comments: `; ...` or `// ...`.
 * Index: IX/IY, (IX+d)/(IY+d), IXH/IXL/IYH/IYL remap, DD/FD CB on (IX+d).
 * CB bit/rot and common ED (blocks, ADC/SBC HL, NEG, IM, RETI, …).
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

interface IndexDisp {
  pref: 0xdd | 0xfd;
  d: number;
}

/** Remapped H/L under DD/FD: IXH/IXL/IYH/IYL. */
interface IndexHalf {
  pref: 0xdd | 0xfd;
  r: 4 | 5; // H or L slot
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
  if (m in simple && a.length === 0) return immBytes(simple[m]!, text, line);

  if (m === 'im') {
    const n = parseImm(a[0] ?? '');
    if (n === 0) return immBytes([0xed, 0x46], text, line);
    if (n === 1) return immBytes([0xed, 0x56], text, line);
    if (n === 2) return immBytes([0xed, 0x5e], text, line);
    throw new Error('IM 0/1/2');
  }

  if (m === 'ex') {
    const x = norm(a[0] ?? '');
    const y = norm(a[1] ?? '');
    if (x === 'de' && y === 'hl') return immBytes([0xeb], text, line);
    if (x === 'af' && (y === "af'" || y === 'af')) return immBytes([0x08], text, line);
    if (x === '(sp)' && y === 'hl') return immBytes([0xe3], text, line);
    if (x === '(sp)' && y === 'ix') return immBytes([0xdd, 0xe3], text, line);
    if (x === '(sp)' && y === 'iy') return immBytes([0xfd, 0xe3], text, line);
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
    const q = norm(a[0] ?? '');
    if (q === 'ix') return immBytes([0xdd, m === 'push' ? 0xe5 : 0xe1], text, line);
    if (q === 'iy') return immBytes([0xfd, m === 'push' ? 0xe5 : 0xe1], text, line);
    const qq = QQ[q];
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
      const t = norm(a[0]!);
      if (t === '(hl)') return immBytes([0xe9], text, line);
      if (t === '(ix)') return immBytes([0xdd, 0xe9], text, line);
      if (t === '(iy)') return immBytes([0xfd, 0xe9], text, line);
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
    if (a.length === 2 && isParen(a[1]!) && norm(stripParens(a[1]!)) === 'c') {
      const r = parseR8(a[0]!);
      if (r === null || r === HLMEM) throw new Error('IN r,(C)');
      return immBytes([0xed, 0x40 | (r << 3)], text, line);
    }
    throw new Error('only IN A,(n) / IN r,(C) supported');
  }
  if (m === 'out') {
    if (a.length === 2 && isParen(a[0]!) && norm(a[1]!) === 'a') {
      const n = parseImm(stripParens(a[0]!));
      if (n === null || n > 0xff) throw new Error('bad OUT port');
      return immBytes([0xd3, n], text, line);
    }
    if (a.length === 2 && isParen(a[0]!) && norm(stripParens(a[0]!)) === 'c') {
      const r = parseR8(a[1]!);
      if (r === null || r === HLMEM) throw new Error('OUT (C),r');
      return immBytes([0xed, 0x41 | (r << 3)], text, line);
    }
    throw new Error('only OUT (n),A / OUT (C),r supported');
  }

  // CB: BIT / SET / RES / rotates
  if (m === 'bit' || m === 'set' || m === 'res') {
    if (a.length !== 2) throw new Error(`${m.toUpperCase()} bit,op`);
    const bit = parseImm(a[0]!);
    if (bit === null || bit < 0 || bit > 7) throw new Error('bit 0..7');
    const x = m === 'bit' ? 1 : m === 'res' ? 2 : 3;
    const op = (x << 6) | (bit << 3);
    return encodeCbOp(op, a[1]!, text, line);
  }
  if (m in CB_ROT) {
    if (a.length !== 1) throw new Error(`${m.toUpperCase()} op`);
    const op = (CB_ROT[m]! << 3);
    return encodeCbOp(op, a[0]!, text, line);
  }

  if (m in ALU) {
    const y = ALU[m]!;
    if (m === 'add' && a.length === 2) {
      const d0 = norm(a[0]!);
      if (d0 === 'hl') {
        const dd = DD[norm(a[1]!)];
        if (dd === undefined) throw new Error('ADD HL,rr');
        return immBytes([0x09 | (dd << 4)], text, line);
      }
      if (d0 === 'ix' || d0 === 'iy') {
        const pref = d0 === 'ix' ? 0xdd : 0xfd;
        const rr = indexPairRr(a[1]!, d0);
        return immBytes([pref, 0x09 | (rr << 4)], text, line);
      }
    }
    if ((m === 'adc' || m === 'sbc') && a.length === 2 && norm(a[0]!) === 'hl') {
      const dd = DD[norm(a[1]!)];
      if (dd === undefined) throw new Error(`${m.toUpperCase()} HL,rr`);
      const base = m === 'adc' ? 0x4a : 0x42;
      return immBytes([0xed, base | (dd << 4)], text, line);
    }
    const op = a.length === 2 && norm(a[0]!) === 'a' ? a[1]! : a.length === 1 ? a[0]! : null;
    if (!op) throw new Error(`${m.toUpperCase()} syntax`);
    const idx = parseIndexDisp(op);
    if (idx) return immBytes([idx.pref, 0x80 | (y << 3) | HLMEM, idx.d], text, line);
    const half = parseIndexHalf(op);
    if (half) return immBytes([half.pref, 0x80 | (y << 3) | half.r], text, line);
    const r = parseR8(op);
    if (r !== null) return immBytes([0x80 | (y << 3) | r], text, line);
    const n = parseImm(op);
    if (n !== null && n <= 0xff) return immBytes([0xc6 | (y << 3), n], text, line);
    throw new Error(`bad ${m.toUpperCase()} operand`);
  }

  if (m === 'inc' || m === 'dec') {
    if (a.length !== 1) throw new Error(`${m.toUpperCase()} needs one operand`);
    const inc = m === 'inc';
    const t = norm(a[0]!);
    if (t === 'ix') return immBytes([0xdd, inc ? 0x23 : 0x2b], text, line);
    if (t === 'iy') return immBytes([0xfd, inc ? 0x23 : 0x2b], text, line);
    const idx = parseIndexDisp(a[0]!);
    if (idx) return immBytes([idx.pref, inc ? 0x34 : 0x35, idx.d], text, line);
    const half = parseIndexHalf(a[0]!);
    if (half) return immBytes([half.pref, (inc ? 0x04 : 0x05) | (half.r << 3)], text, line);
    const dd = DD[t];
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

function encodeCbOp(opBase: number, operand: string, text: string, line: number): Emit {
  const idx = parseIndexDisp(operand);
  if (idx) {
    // DD/FD CB d (op|6) — only (IX+d)/(IY+d) form in this sim's documented slice
    return immBytes([idx.pref, 0xcb, idx.d, opBase | HLMEM], text, line);
  }
  const r = parseR8(operand);
  if (r === null) throw new Error(`bad CB operand '${operand}'`);
  return immBytes([0xcb, opBase | r], text, line);
}

function encodeLd(dst: string, src: string, text: string, line: number): Emit {
  const d = norm(dst);
  const s = norm(src);

  // I / R
  if (d === 'a' && s === 'i') return immBytes([0xed, 0x57], text, line);
  if (d === 'a' && s === 'r') return immBytes([0xed, 0x5f], text, line);
  if (d === 'i' && s === 'a') return immBytes([0xed, 0x47], text, line);
  if (d === 'r' && s === 'a') return immBytes([0xed, 0x4f], text, line);

  if (d === 'sp' && s === 'hl') return immBytes([0xf9], text, line);
  if (d === 'sp' && s === 'ix') return immBytes([0xdd, 0xf9], text, line);
  if (d === 'sp' && s === 'iy') return immBytes([0xfd, 0xf9], text, line);

  // IX / IY as 16-bit
  if (d === 'ix' || d === 'iy') {
    const pref = d === 'ix' ? 0xdd : 0xfd;
    if (isAbsMem(src)) return { kind: 'abs', opcode: [pref, 0x2a], target: stripParens(src), text, line };
    if (parseImm(src) !== null) {
      const n = parseImm(src)!;
      return immBytes([pref, 0x21, n & 0xff, (n >> 8) & 0xff], text, line);
    }
    return { kind: 'abs', opcode: [pref, 0x21], target: src, text, line };
  }
  if ((s === 'ix' || s === 'iy') && isAbsMem(dst)) {
    const pref = s === 'ix' ? 0xdd : 0xfd;
    return { kind: 'abs', opcode: [pref, 0x22], target: stripParens(dst), text, line };
  }

  const dd = DD[d];
  if (dd !== undefined && !isParen(dst)) {
    if (isAbsMem(src)) {
      // ED LD dd,(nn) — not for HL (uses 2A)
      if (d === 'hl') return { kind: 'abs', opcode: [0x2a], target: stripParens(src), text, line };
      return { kind: 'abs', opcode: [0xed, 0x4b | (dd << 4)], target: stripParens(src), text, line };
    }
    if (parseImm(src) !== null) {
      const n = parseImm(src)!;
      return immBytes([0x01 | (dd << 4), n & 0xff, (n >> 8) & 0xff], text, line);
    }
    return { kind: 'abs', opcode: [0x01 | (dd << 4)], target: src, text, line };
  }

  if (isAbsMem(dst) && !isParen(src)) {
    const ss = DD[s];
    if (ss !== undefined) {
      if (s === 'hl') return { kind: 'abs', opcode: [0x22], target: stripParens(dst), text, line };
      return { kind: 'abs', opcode: [0xed, 0x43 | (ss << 4)], target: stripParens(dst), text, line };
    }
  }

  if (isAbsMem(dst) && s === 'a') return { kind: 'abs', opcode: [0x32], target: stripParens(dst), text, line };
  if (d === 'a' && isAbsMem(src)) return { kind: 'abs', opcode: [0x3a], target: stripParens(src), text, line };

  if (d === '(bc)' && s === 'a') return immBytes([0x02], text, line);
  if (d === 'a' && s === '(bc)') return immBytes([0x0a], text, line);
  if (d === '(de)' && s === 'a') return immBytes([0x12], text, line);
  if (d === 'a' && s === '(de)') return immBytes([0x1a], text, line);

  // (IX+d) / (IY+d)
  const dstIdx = parseIndexDisp(dst);
  const srcIdx = parseIndexDisp(src);
  if (dstIdx && srcIdx) throw new Error('LD (IX+d),(IY+d) illegal');
  if (dstIdx) {
    const n = parseImm(src);
    if (n !== null && n <= 0xff) return immBytes([dstIdx.pref, 0x36, dstIdx.d, n], text, line);
    const r = parseR8(src);
    if (r !== null && r !== HLMEM) return immBytes([dstIdx.pref, 0x70 | r, dstIdx.d], text, line);
    throw new Error('LD (IX+d),op');
  }
  if (srcIdx) {
    const r = parseR8(dst);
    if (r !== null && r !== HLMEM) return immBytes([srcIdx.pref, 0x40 | (r << 3) | HLMEM, srcIdx.d], text, line);
    throw new Error('LD r,(IX+d)');
  }

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

  // IXH/IXL/IYH/IYL remap
  const dh = parseIndexHalf(dst);
  const sh = parseIndexHalf(src);
  if (dh || sh) {
    const pref = (dh ?? sh)!.pref;
    if (dh && sh && dh.pref !== sh.pref) throw new Error('mixed IX/IY halves');
    if (dh && sh) return immBytes([pref, 0x40 | (dh.r << 3) | sh.r], text, line);
    if (dh) {
      const n = parseImm(src);
      if (n !== null && n <= 0xff) return immBytes([pref, 0x06 | (dh.r << 3), n], text, line);
      const rs = parseR8(src);
      if (rs !== null && rs !== HLMEM) return immBytes([pref, 0x40 | (dh.r << 3) | rs], text, line);
    }
    if (sh) {
      const rd = parseR8(dst);
      if (rd !== null && rd !== HLMEM) return immBytes([pref, 0x40 | (rd << 3) | sh.r], text, line);
    }
    throw new Error(`unsupported LD ${dst},${src}`);
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

/** ADD IX,rr — rr is BC/DE/IX/SP (IY for ADD IY). */
function indexPairRr(arg: string, self: 'ix' | 'iy'): number {
  const t = norm(arg);
  if (t === 'bc') return 0;
  if (t === 'de') return 1;
  if (t === self) return 2; // IX/IY in HL slot
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
  if (/^(ix|iy)\b/i.test(inner.trim())) return false;
  if (['hl', 'bc', 'de', 'sp'].includes(norm(inner))) return false;
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
