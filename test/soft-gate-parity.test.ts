import { describe, expect, it } from 'vitest';
import { createSoftZ80, softRun, type SoftZ80State } from '../src/machine/softZ80.js';
import { makeZ80Harness, type Z80Harness } from './z80Harness.js';

/**
 * Soft vs gate register/RAM parity for a shared unprefixed (+ CB) suite.
 *
 * Flag mask excludes:
 * - X (bit 3) / Y (bit 5): undocumented; soft never writes them, gate often
 *   copies them from the result byte.
 * - P/V (bit 2): soft ALU/INC/DEC uses parity; gate uses signed overflow for
 *   arithmetic. Documented bits S/Z/H/N/C are compared.
 *
 * Cases intentionally omitted here (use dedicated z80cpu-* tests):
 * - CALL/RET / PUSH/POP stack traffic — soft pushes 2 bytes; some gate paths
 *   need more than one 10-phase `runInstruction` per soft step for multi-byte
 *   stack ops under addrBits=7.
 * - ED/DD/FD — prefixed ops often need >10 FSM phases per instruction; soft
 *   counts one softStep. Keep those in z80cpu-ldi / z80cpu-dd-ix etc.
 *
 * Covered: LD/ALU/JR/INC/CB RLC/XOR/OR/CP/abs LD.
 */
const FLAG_MASK = 0xd3; // S Z - H - - N C  (exclude Y=0x20, X=0x08, P/V=0x04)

interface Snapshot {
  a: number;
  f: number;
  bc: number;
  de: number;
  hl: number;
  sp: number;
  pc: number;
  ram: number[];
}

function softSnap(cpu: SoftZ80State, ram: Uint8Array, addrs: number[]): Snapshot {
  return {
    a: cpu.a,
    f: cpu.f & FLAG_MASK,
    bc: (cpu.b << 8) | cpu.c,
    de: (cpu.d << 8) | cpu.e,
    hl: (cpu.h << 8) | cpu.l,
    sp: cpu.sp,
    pc: cpu.pc,
    ram: addrs.map((a) => ram[a] ?? 0),
  };
}

function gateSnap(h: Z80Harness, addrs: number[]): Snapshot {
  const { cpu, readReg } = h;
  return {
    a: readReg(cpu.a),
    f: readReg(cpu.f) & FLAG_MASK,
    bc: (readReg(cpu.rB.q) << 8) | readReg(cpu.rC.q),
    de: (readReg(cpu.rD.q) << 8) | readReg(cpu.rE.q),
    hl: (readReg(cpu.rH.q) << 8) | readReg(cpu.rL.q),
    sp: readReg(cpu.sp.q),
    pc: readReg(cpu.pc),
    ram: addrs.map((a) => cpu.ram.bytes[a] ?? 0),
  };
}

function expectParity(label: string, soft: Snapshot, gate: Snapshot): void {
  const fields: (keyof Snapshot)[] = ['a', 'f', 'bc', 'de', 'hl', 'sp', 'pc'];
  for (const k of fields) {
    expect(gate[k], `${label}: gate.${k}=${gate[k]} soft.${k}=${soft[k]}`).toBe(soft[k]);
  }
  expect(gate.ram, `${label}: RAM bytes`).toEqual(soft.ram);
}

/**
 * Run the same program bytes on softZ80 and on buildZ80Cpu (via makeZ80Harness).
 * Soft runs until HALT (or maxSteps); gate runs the same instruction count.
 * Gate HALT (0x76) is inert but still advances PC like a 1-byte NOP — matching
 * soft's fetch-then-halt PC.
 */
function runBoth(program: Uint8Array, ramAddrs: number[], maxSteps = 16) {
  const softRam = new Uint8Array(1 << 7);
  softRam.set(program);
  const softCpu = createSoftZ80(0);
  const steps = softRun(softCpu, softRam, maxSteps);
  expect(steps, 'soft should retire at least one instruction').toBeGreaterThan(0);
  expect(softCpu.halted, 'soft programs should end in HALT').toBe(true);

  const h = makeZ80Harness(Uint8Array.from(program), 7);
  for (let i = 0; i < steps; i++) h.runInstruction();

  return {
    soft: softSnap(softCpu, softRam, ramAddrs),
    gate: gateSnap(h, ramAddrs),
    steps,
  };
}

describe('softZ80 vs buildZ80Cpu parity', () => {
  it('LD A,n / ADD A,n / HALT', () => {
    const program = new Uint8Array([0x3e, 0x02, 0xc6, 0x03, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('LD/ADD', soft, gate);
    expect(soft.a).toBe(5);
  });

  it('LD HL,nn / LD (HL),A / HALT', () => {
    const program = new Uint8Array([0x3e, 0xab, 0x21, 0x10, 0x00, 0x77, 0x76]);
    const { soft, gate } = runBoth(program, [0x10]);
    expectParity('LD (HL),A', soft, gate);
    expect(soft.ram[0]).toBe(0xab);
    expect(soft.hl).toBe(0x10);
  });

  it('JR relative skip / HALT', () => {
    const program = new Uint8Array([0x18, 0x02, 0x00, 0x00, 0x3e, 0x42, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('JR', soft, gate);
    expect(soft.a).toBe(0x42);
  });

  it('simple DEC A / JR NZ loop / HALT', () => {
    const program = new Uint8Array([0x3e, 0x02, 0x3d, 0x20, 0xfd, 0x76]);
    const { soft, gate, steps } = runBoth(program, [], 16);
    expect(steps).toBeGreaterThan(3);
    expectParity('JR NZ loop', soft, gate);
    expect(soft.a).toBe(0);
  });

  it('CB RLC A / HALT', () => {
    const program = new Uint8Array([0x3e, 0x81, 0xcb, 0x07, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('RLC A', soft, gate);
    expect(soft.a).toBe(0x03);
    expect(soft.f & 0x01).toBe(0x01);
  });

  it('LD BC,nn / INC BC / HALT', () => {
    const program = new Uint8Array([0x01, 0x34, 0x12, 0x03, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('INC BC', soft, gate);
    expect(soft.bc).toBe(0x1235);
  });

  it('XOR A / OR n / HALT', () => {
    const program = new Uint8Array([0xaf, 0xf6, 0x0f, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('XOR/OR', soft, gate);
    expect(soft.a).toBe(0x0f);
  });

  it('CP n / HALT', () => {
    const program = new Uint8Array([0x3e, 0x05, 0xfe, 0x06, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('CP', soft, gate);
    expect(soft.a).toBe(0x05);
    expect(soft.f & 0x40).toBe(0);
    expect(soft.f & 0x01).toBe(0x01);
    expect(soft.f & 0x02).toBe(0x02);
  });

  it('LD A,(nn) / LD (nn),A / HALT', () => {
    const program = new Uint8Array([0x3e, 0xab, 0x32, 0x40, 0x00, 0xaf, 0x3a, 0x40, 0x00, 0x76]);
    const { soft, gate } = runBoth(program, [0x40]);
    expectParity('LD (nn),A / LD A,(nn)', soft, gate);
    expect(soft.a).toBe(0xab);
    expect(soft.ram[0]).toBe(0xab);
  });

  it('AND n / XOR n / HALT', () => {
    // LD A,0xF0 / AND 0x3C / XOR 0x0F / HALT → A=0x3F
    const program = new Uint8Array([0x3e, 0xf0, 0xe6, 0x3c, 0xee, 0x0f, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('AND/XOR', soft, gate);
    expect(soft.a).toBe(0x3f);
  });

  it('LD DE,nn / DEC DE / HALT', () => {
    const program = new Uint8Array([0x11, 0x00, 0x10, 0x1b, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('DEC DE', soft, gate);
    expect(soft.de).toBe(0x0fff);
  });

  it('SCF / CCF / HALT', () => {
    const program = new Uint8Array([0x37, 0x3f, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('SCF/CCF', soft, gate);
    expect(soft.f & 0x01).toBe(0);
  });
});
