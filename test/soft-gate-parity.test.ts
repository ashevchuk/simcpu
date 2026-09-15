import { describe, expect, it } from 'vitest';
import { createSoftZ80, softRun, type SoftZ80State } from '../src/machine/softZ80.js';
import { makeZ80Harness, type Z80Harness } from './z80Harness.js';

/**
 * Soft vs gate register/RAM parity for a tiny shared opcode suite.
 *
 * Flag mask excludes:
 * - X (bit 3) / Y (bit 5): undocumented; soft never writes them, gate often
 *   copies them from the result byte.
 * - P/V (bit 2): soft ALU/INC/DEC uses parity; gate uses signed overflow for
 *   arithmetic. Documented bits S/Z/H/N/C are compared.
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
    // LD A,2 / ADD A,3 / HALT — result 5 (P/V excluded from FLAG_MASK)
    const program = new Uint8Array([0x3e, 0x02, 0xc6, 0x03, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('LD/ADD', soft, gate);
    expect(soft.a).toBe(5);
  });

  it('LD HL,nn / LD (HL),A / HALT', () => {
    // LD A,0xAB / LD HL,0x10 / LD (HL),A / HALT
    const program = new Uint8Array([0x3e, 0xab, 0x21, 0x10, 0x00, 0x77, 0x76]);
    const { soft, gate } = runBoth(program, [0x10]);
    expectParity('LD (HL),A', soft, gate);
    expect(soft.ram[0]).toBe(0xab);
    expect(soft.hl).toBe(0x10);
  });

  it('JR relative skip / HALT', () => {
    // JR +2 / NOP / NOP / LD A,0x42 / HALT
    const program = new Uint8Array([0x18, 0x02, 0x00, 0x00, 0x3e, 0x42, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('JR', soft, gate);
    expect(soft.a).toBe(0x42);
  });

  it('simple DEC A / JR NZ loop / HALT', () => {
    // LD A,2 / DEC A / JR NZ,-3 / HALT  → A=0 after two DECs
    const program = new Uint8Array([0x3e, 0x02, 0x3d, 0x20, 0xfd, 0x76]);
    const { soft, gate, steps } = runBoth(program, [], 16);
    expect(steps).toBeGreaterThan(3);
    expectParity('JR NZ loop', soft, gate);
    expect(soft.a).toBe(0);
  });

  it('CB RLC A / HALT', () => {
    // LD A,0x81 / RLC A / HALT → A=0x03, C=1; both paths use parity for P
    const program = new Uint8Array([0x3e, 0x81, 0xcb, 0x07, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('RLC A', soft, gate);
    expect(soft.a).toBe(0x03);
    expect(soft.f & 0x01).toBe(0x01);
  });
});
