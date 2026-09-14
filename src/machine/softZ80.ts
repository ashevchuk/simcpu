/**
 * Soft Z80 interpreter for MachineRunner Run — behavioral, same trade-off as
 * RamComponent / TTY. Drives the shared `ram.bytes` so the panel sees results
 * immediately. Not transistor-accurate timing; gate-level Step still uses
 * the real circuit.
 *
 * Covers the unprefixed subset the command ROM (and typical panel asm) needs.
 * Prefixed CB/ED/DD/FD: throws so a bad program fails loudly.
 */

export interface SoftZ80State {
  a: number;
  f: number;
  b: number;
  c: number;
  d: number;
  e: number;
  h: number;
  l: number;
  sp: number;
  pc: number;
  halted: boolean;
}

const FLAG_C = 0x01;
const FLAG_N = 0x02;
const FLAG_P = 0x04;
const FLAG_H = 0x10;
const FLAG_Z = 0x40;
const FLAG_S = 0x80;

export function createSoftZ80(sp = 0xdff): SoftZ80State {
  return {
    a: 0,
    f: 0,
    b: 0,
    c: 0,
    d: 0,
    e: 0,
    h: 0,
    l: 0,
    sp: sp & 0xffff,
    pc: 0,
    halted: false,
  };
}

function u8(n: number): number {
  return n & 0xff;
}
function u16(n: number): number {
  return n & 0xffff;
}
function s8(n: number): number {
  return n & 0x80 ? n - 256 : n;
}

function parity(n: number): boolean {
  let x = n & 0xff;
  x ^= x >> 4;
  x ^= x >> 2;
  x ^= x >> 1;
  return (x & 1) === 0;
}

function setSZP(f: number, n: number): number {
  n = u8(n);
  f = (f & ~(FLAG_S | FLAG_Z | FLAG_P)) | (n & FLAG_S) | (n === 0 ? FLAG_Z : 0) | (parity(n) ? FLAG_P : 0);
  return f;
}

function read16(ram: Uint8Array, addr: number): number {
  return ram[addr & 0xffff]! | (ram[(addr + 1) & 0xffff]! << 8);
}
function write16(ram: Uint8Array, addr: number, v: number): void {
  ram[addr & 0xffff] = v & 0xff;
  ram[(addr + 1) & 0xffff] = (v >> 8) & 0xff;
}

function getR(cpu: SoftZ80State, r: number): number {
  switch (r) {
    case 0:
      return cpu.b;
    case 1:
      return cpu.c;
    case 2:
      return cpu.d;
    case 3:
      return cpu.e;
    case 4:
      return cpu.h;
    case 5:
      return cpu.l;
    case 7:
      return cpu.a;
    default:
      throw new Error('getR (HL)');
  }
}
function setR(cpu: SoftZ80State, r: number, v: number): void {
  v = u8(v);
  switch (r) {
    case 0:
      cpu.b = v;
      break;
    case 1:
      cpu.c = v;
      break;
    case 2:
      cpu.d = v;
      break;
    case 3:
      cpu.e = v;
      break;
    case 4:
      cpu.h = v;
      break;
    case 5:
      cpu.l = v;
      break;
    case 7:
      cpu.a = v;
      break;
    default:
      throw new Error('setR (HL)');
  }
}

function hl(cpu: SoftZ80State): number {
  return (cpu.h << 8) | cpu.l;
}
function setHl(cpu: SoftZ80State, v: number): void {
  v = u16(v);
  cpu.h = v >> 8;
  cpu.l = v & 0xff;
}
function bc(cpu: SoftZ80State): number {
  return (cpu.b << 8) | cpu.c;
}
function de(cpu: SoftZ80State): number {
  return (cpu.d << 8) | cpu.e;
}
function setBc(cpu: SoftZ80State, v: number): void {
  v = u16(v);
  cpu.b = v >> 8;
  cpu.c = v & 0xff;
}
function setDe(cpu: SoftZ80State, v: number): void {
  v = u16(v);
  cpu.d = v >> 8;
  cpu.e = v & 0xff;
}

function push(cpu: SoftZ80State, ram: Uint8Array, v: number): void {
  cpu.sp = u16(cpu.sp - 2);
  write16(ram, cpu.sp, v);
}
function pop(cpu: SoftZ80State, ram: Uint8Array): number {
  const v = read16(ram, cpu.sp);
  cpu.sp = u16(cpu.sp + 2);
  return v;
}

function fetch(cpu: SoftZ80State, ram: Uint8Array): number {
  const b = ram[cpu.pc]! & 0xff;
  cpu.pc = u16(cpu.pc + 1);
  return b;
}
function fetch16(cpu: SoftZ80State, ram: Uint8Array): number {
  const lo = fetch(cpu, ram);
  const hi = fetch(cpu, ram);
  return lo | (hi << 8);
}

function cond(cpu: SoftZ80State, cc: number): boolean {
  const f = cpu.f;
  switch (cc) {
    case 0:
      return (f & FLAG_Z) === 0;
    case 1:
      return (f & FLAG_Z) !== 0;
    case 2:
      return (f & FLAG_C) === 0;
    case 3:
      return (f & FLAG_C) !== 0;
    case 4:
      return (f & FLAG_P) === 0;
    case 5:
      return (f & FLAG_P) !== 0;
    case 6:
      return (f & FLAG_S) === 0;
    case 7:
      return (f & FLAG_S) !== 0;
    default:
      return false;
  }
}

function aluOp(cpu: SoftZ80State, y: number, val: number): void {
  const a = cpu.a;
  let res = 0;
  let f = cpu.f;
  switch (y) {
    case 0: {
      // ADD
      const r = a + val;
      res = u8(r);
      f = (f & ~(FLAG_C | FLAG_N | FLAG_H)) | (r > 0xff ? FLAG_C : 0) | (((a & 0xf) + (val & 0xf)) > 0xf ? FLAG_H : 0);
      break;
    }
    case 1: {
      // ADC
      const c = f & FLAG_C ? 1 : 0;
      const r = a + val + c;
      res = u8(r);
      f = (f & ~(FLAG_C | FLAG_N | FLAG_H)) | (r > 0xff ? FLAG_C : 0) | (((a & 0xf) + (val & 0xf) + c) > 0xf ? FLAG_H : 0);
      break;
    }
    case 2: {
      // SUB
      const r = a - val;
      res = u8(r);
      f = (f & ~(FLAG_C | FLAG_H)) | FLAG_N | (r < 0 ? FLAG_C : 0) | (((a & 0xf) - (val & 0xf)) < 0 ? FLAG_H : 0);
      break;
    }
    case 3: {
      // SBC
      const c = f & FLAG_C ? 1 : 0;
      const r = a - val - c;
      res = u8(r);
      f = (f & ~(FLAG_C | FLAG_H)) | FLAG_N | (r < 0 ? FLAG_C : 0) | (((a & 0xf) - (val & 0xf) - c) < 0 ? FLAG_H : 0);
      break;
    }
    case 4: // AND
      res = a & val;
      f = (f & ~(FLAG_C | FLAG_N)) | FLAG_H;
      break;
    case 5: // XOR
      res = a ^ val;
      f = f & ~(FLAG_C | FLAG_N | FLAG_H);
      break;
    case 6: // OR
      res = a | val;
      f = f & ~(FLAG_C | FLAG_N | FLAG_H);
      break;
    case 7: {
      // CP
      const r = a - val;
      res = a; // A unchanged
      f = (f & ~(FLAG_C | FLAG_H)) | FLAG_N | (r < 0 ? FLAG_C : 0) | (((a & 0xf) - (val & 0xf)) < 0 ? FLAG_H : 0);
      f = setSZP(f, u8(r));
      cpu.f = f;
      return;
    }
  }
  cpu.a = res;
  cpu.f = setSZP(f, res);
}

/** Execute one instruction. Returns false if halted / unsupported. */
export function softStep(cpu: SoftZ80State, ram: Uint8Array): boolean {
  if (cpu.halted) return false;
  const op = fetch(cpu, ram);

  if (op === 0xcb || op === 0xed || op === 0xdd || op === 0xfd) {
    throw new Error(`soft Z80: prefix 0x${op.toString(16)} not implemented — use gate Step`);
  }

  // NOP
  if (op === 0x00) return true;
  if (op === 0x76) {
    cpu.halted = true;
    return false;
  }

  // LD r,r' / LD r,(HL) / LD (HL),r
  if ((op & 0xc0) === 0x40 && op !== 0x76) {
    const y = (op >> 3) & 7;
    const z = op & 7;
    const val = z === 6 ? ram[hl(cpu)]! : getR(cpu, z);
    if (y === 6) ram[hl(cpu)] = u8(val);
    else setR(cpu, y, val);
    return true;
  }

  // ALU A,r / A,(HL)
  if ((op & 0xc0) === 0x80) {
    const y = (op >> 3) & 7;
    const z = op & 7;
    const val = z === 6 ? ram[hl(cpu)]! : getR(cpu, z);
    aluOp(cpu, y, val);
    return true;
  }

  // ALU A,n
  if ((op & 0xc7) === 0xc6) {
    aluOp(cpu, (op >> 3) & 7, fetch(cpu, ram));
    return true;
  }

  // LD r,n
  if ((op & 0xc7) === 0x06) {
    const y = (op >> 3) & 7;
    const n = fetch(cpu, ram);
    if (y === 6) ram[hl(cpu)] = n;
    else setR(cpu, y, n);
    return true;
  }

  // INC/DEC r / (HL)
  if ((op & 0xc7) === 0x04 || (op & 0xc7) === 0x05) {
    const y = (op >> 3) & 7;
    const inc = (op & 0xc7) === 0x04;
    let v = y === 6 ? ram[hl(cpu)]! : getR(cpu, y);
    const old = v;
    v = u8(inc ? v + 1 : v - 1);
    if (y === 6) ram[hl(cpu)] = v;
    else setR(cpu, y, v);
    let f = cpu.f & FLAG_C;
    f = setSZP(f, v);
    f = (f & ~FLAG_N) | (inc ? 0 : FLAG_N);
    f = (f & ~FLAG_H) | ((inc ? (old & 0xf) === 0xf : (old & 0xf) === 0) ? FLAG_H : 0);
    cpu.f = f;
    return true;
  }

  // INC/DEC rr
  if ((op & 0xcf) === 0x03 || (op & 0xcf) === 0x0b) {
    const p = (op >> 4) & 3;
    const inc = (op & 0xcf) === 0x03;
    const d = inc ? 1 : -1;
    if (p === 0) setBc(cpu, bc(cpu) + d);
    else if (p === 1) setDe(cpu, de(cpu) + d);
    else if (p === 2) setHl(cpu, hl(cpu) + d);
    else cpu.sp = u16(cpu.sp + d);
    return true;
  }

  // LD rr,nn
  if ((op & 0xcf) === 0x01) {
    const nn = fetch16(cpu, ram);
    const p = (op >> 4) & 3;
    if (p === 0) setBc(cpu, nn);
    else if (p === 1) setDe(cpu, nn);
    else if (p === 2) setHl(cpu, nn);
    else cpu.sp = nn;
    return true;
  }

  // ADD HL,rr
  if ((op & 0xcf) === 0x09) {
    const p = (op >> 4) & 3;
    const addend = p === 0 ? bc(cpu) : p === 1 ? de(cpu) : p === 2 ? hl(cpu) : cpu.sp;
    const r = hl(cpu) + addend;
    cpu.f = (cpu.f & ~(FLAG_C | FLAG_N | FLAG_H)) | (r > 0xffff ? FLAG_C : 0);
    setHl(cpu, r);
    return true;
  }

  // JR e / JR cc,e / DJNZ
  if (op === 0x18 || op === 0x10 || (op & 0xe7) === 0x20) {
    const e = s8(fetch(cpu, ram));
    let take = op === 0x18;
    if (op === 0x10) {
      cpu.b = u8(cpu.b - 1);
      take = cpu.b !== 0;
    } else if (op !== 0x18) {
      take = cond(cpu, (op >> 3) & 3);
    }
    if (take) cpu.pc = u16(cpu.pc + e);
    return true;
  }

  // JP nn / JP cc,nn
  if (op === 0xc3 || (op & 0xc7) === 0xc2) {
    const nn = fetch16(cpu, ram);
    if (op === 0xc3 || cond(cpu, (op >> 3) & 7)) cpu.pc = nn;
    return true;
  }

  // CALL nn / CALL cc,nn
  if (op === 0xcd || (op & 0xc7) === 0xc4) {
    const nn = fetch16(cpu, ram);
    if (op === 0xcd || cond(cpu, (op >> 3) & 7)) {
      push(cpu, ram, cpu.pc);
      cpu.pc = nn;
    }
    return true;
  }

  // RET / RET cc
  if (op === 0xc9 || (op & 0xc7) === 0xc0) {
    if (op === 0xc9 || cond(cpu, (op >> 3) & 7)) cpu.pc = pop(cpu, ram);
    return true;
  }

  // PUSH/POP qq
  if ((op & 0xcf) === 0xc5 || (op & 0xcf) === 0xc1) {
    const p = (op >> 4) & 3;
    const isPush = (op & 0xcf) === 0xc5;
    if (isPush) {
      const v = p === 0 ? bc(cpu) : p === 1 ? de(cpu) : p === 2 ? hl(cpu) : (cpu.a << 8) | cpu.f;
      push(cpu, ram, v);
    } else {
      const v = pop(cpu, ram);
      if (p === 0) setBc(cpu, v);
      else if (p === 1) setDe(cpu, v);
      else if (p === 2) setHl(cpu, v);
      else {
        cpu.a = v >> 8;
        cpu.f = v & 0xff;
      }
    }
    return true;
  }

  // JP (HL)
  if (op === 0xe9) {
    cpu.pc = hl(cpu);
    return true;
  }
  // LD SP,HL
  if (op === 0xf9) {
    cpu.sp = hl(cpu);
    return true;
  }
  // EX DE,HL
  if (op === 0xeb) {
    const t = de(cpu);
    setDe(cpu, hl(cpu));
    setHl(cpu, t);
    return true;
  }
  // EX (SP),HL
  if (op === 0xe3) {
    const t = read16(ram, cpu.sp);
    write16(ram, cpu.sp, hl(cpu));
    setHl(cpu, t);
    return true;
  }
  // EXX
  if (op === 0xd9) return true; // shadows not modeled — no-op for soft path
  // EX AF,AF'
  if (op === 0x08) return true;
  // DI / EI
  if (op === 0xf3 || op === 0xfb) return true;

  // LD A,(BC)/(DE) / LD (BC)/(DE),A
  if (op === 0x0a) {
    cpu.a = ram[bc(cpu)]!;
    return true;
  }
  if (op === 0x1a) {
    cpu.a = ram[de(cpu)]!;
    return true;
  }
  if (op === 0x02) {
    ram[bc(cpu)] = cpu.a;
    return true;
  }
  if (op === 0x12) {
    ram[de(cpu)] = cpu.a;
    return true;
  }

  // LD A,(nn) / LD (nn),A
  if (op === 0x3a) {
    cpu.a = ram[fetch16(cpu, ram)]!;
    return true;
  }
  if (op === 0x32) {
    ram[fetch16(cpu, ram)] = cpu.a;
    return true;
  }
  // LD HL,(nn) / LD (nn),HL
  if (op === 0x2a) {
    setHl(cpu, read16(ram, fetch16(cpu, ram)));
    return true;
  }
  if (op === 0x22) {
    write16(ram, fetch16(cpu, ram), hl(cpu));
    return true;
  }

  // RRCA / RLCA / RRA / RLA
  if (op === 0x0f) {
    const c = cpu.a & 1;
    cpu.a = u8((cpu.a >> 1) | (c << 7));
    cpu.f = (cpu.f & ~(FLAG_C | FLAG_N | FLAG_H)) | (c ? FLAG_C : 0);
    return true;
  }
  if (op === 0x07) {
    const c = (cpu.a >> 7) & 1;
    cpu.a = u8((cpu.a << 1) | c);
    cpu.f = (cpu.f & ~(FLAG_C | FLAG_N | FLAG_H)) | (c ? FLAG_C : 0);
    return true;
  }
  if (op === 0x1f) {
    const c = cpu.a & 1;
    const oldC = cpu.f & FLAG_C ? 1 : 0;
    cpu.a = u8((cpu.a >> 1) | (oldC << 7));
    cpu.f = (cpu.f & ~(FLAG_C | FLAG_N | FLAG_H)) | (c ? FLAG_C : 0);
    return true;
  }
  if (op === 0x17) {
    const c = (cpu.a >> 7) & 1;
    const oldC = cpu.f & FLAG_C ? 1 : 0;
    cpu.a = u8((cpu.a << 1) | oldC);
    cpu.f = (cpu.f & ~(FLAG_C | FLAG_N | FLAG_H)) | (c ? FLAG_C : 0);
    return true;
  }

  // SCF / CCF / CPL / DAA (DAA simplified — enough for soft demos)
  if (op === 0x37) {
    cpu.f = (cpu.f & ~(FLAG_N | FLAG_H)) | FLAG_C;
    return true;
  }
  if (op === 0x3f) {
    cpu.f = (cpu.f & ~(FLAG_N | FLAG_H)) ^ FLAG_C;
    return true;
  }
  if (op === 0x2f) {
    cpu.a = u8(~cpu.a);
    cpu.f = cpu.f | FLAG_N | FLAG_H;
    return true;
  }
  if (op === 0x27) return true;

  // RST
  if ((op & 0xc7) === 0xc7) {
    push(cpu, ram, cpu.pc);
    cpu.pc = op & 0x38;
    return true;
  }

  // IN A,(n) / OUT (n),A — no soft I/O ports; absorb
  if (op === 0xdb) {
    fetch(cpu, ram);
    cpu.a = 0xff;
    return true;
  }
  if (op === 0xd3) {
    fetch(cpu, ram);
    return true;
  }

  throw new Error(`soft Z80: unimplemented opcode 0x${op.toString(16)} at PC`);
}

/** Run up to `max` instructions or until halted. Returns steps taken. */
export function softRun(cpu: SoftZ80State, ram: Uint8Array, max: number): number {
  let n = 0;
  while (n < max && !cpu.halted) {
    softStep(cpu, ram);
    n++;
  }
  return n;
}
