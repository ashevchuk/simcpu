import { describe, expect, it } from 'vitest';
import { createSoftZ80, softStep, type SoftZ80State } from '../src/machine/softZ80.js';
import { makeZ80Harness, type Z80Harness } from './z80Harness.js';

/**
 * Soft vs gate register/RAM parity.
 *
 * Flag mask excludes:
 * - X (bit 3) / Y (bit 5): undocumented; soft never writes them, gate often
 *   copies them from the result byte.
 * - P/V (bit 2): soft ALU/INC/DEC uses parity; gate uses signed overflow for
 *   arithmetic. Documented bits S/Z/H/N/C are compared.
 *
 * Stack-heavy CALL/RET/PUSH/POP beyond simple DD IX forms stay in dedicated
 * z80cpu-* tests — soft may retire in one step while some gate paths need
 * careful SP mid-instruction matching beyond PC catch-up.
 *
 * ED/DD: soft counts one softStep for the whole prefixed op; the gate may
 * need more than one 10-phase ring. `gateCatchUp` runs rings until PC matches.
 */
const FLAG_MASK = 0xd3; // S Z - H - - N C  (exclude Y=0x20, X=0x08, P/V=0x04)

interface Snapshot {
  a: number;
  f: number;
  bc: number;
  de: number;
  hl: number;
  ix: number;
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
    ix: cpu.ix & 0xffff,
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
    ix: (readReg(cpu.rIXH.q) << 8) | readReg(cpu.rIXL.q),
    sp: readReg(cpu.sp.q),
    pc: readReg(cpu.pc),
    ram: addrs.map((a) => cpu.ram.bytes[a] ?? 0),
  };
}

function expectParity(label: string, soft: Snapshot, gate: Snapshot): void {
  const fields: (keyof Snapshot)[] = ['a', 'f', 'bc', 'de', 'hl', 'ix', 'sp', 'pc'];
  for (const k of fields) {
    expect(gate[k], `${label}: gate.${k}=${gate[k]} soft.${k}=${soft[k]}`).toBe(soft[k]);
  }
  expect(gate.ram, `${label}: RAM bytes`).toEqual(soft.ram);
}

/**
 * Advance the gate until its PC matches soft's PC after one softStep.
 * Unprefixed ops usually need one 10-phase ring; ED/DD bodies that burn
 * prefix phases plus a long execute window may need a second ring.
 */
function gateCatchUp(h: Z80Harness, targetPc: number): void {
  h.runInstruction();
  let extra = 0;
  while (h.readReg(h.cpu.pc) !== targetPc) {
    h.runInstruction();
    if (++extra > 4) {
      throw new Error(
        `gateCatchUp: gate PC=${h.readReg(h.cpu.pc)} still != soft PC=${targetPc} after ${extra + 1} rings`,
      );
    }
  }
}

/**
 * Run the same program bytes on softZ80 and on buildZ80Cpu (via makeZ80Harness).
 * Soft runs until HALT (or maxSteps); gate catch-up follows each soft step.
 * Gate HALT (0x76) is inert but still advances PC like a 1-byte NOP — matching
 * soft's fetch-then-halt PC.
 */
function runBoth(program: Uint8Array, ramAddrs: number[], maxSteps = 16) {
  const softRam = new Uint8Array(1 << 7);
  softRam.set(program);
  const softCpu = createSoftZ80(0);
  let steps = 0;
  while (steps < maxSteps && !softCpu.halted) {
    softStep(softCpu, softRam);
    steps++;
  }
  expect(steps, 'soft should retire at least one instruction').toBeGreaterThan(0);
  expect(softCpu.halted, 'soft programs should end in HALT').toBe(true);

  // Re-run soft step-by-step alongside the gate so catch-up sees each target PC.
  const soft2Ram = new Uint8Array(1 << 7);
  soft2Ram.set(program);
  const soft2 = createSoftZ80(0);
  const h = makeZ80Harness(Uint8Array.from(program), 7);
  for (let i = 0; i < steps; i++) {
    softStep(soft2, soft2Ram);
    gateCatchUp(h, soft2.pc);
  }

  return {
    soft: softSnap(soft2, soft2Ram, ramAddrs),
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

  it('ED NEG / HALT', () => {
    // LD A,0x01 / ED NEG / HALT → A=0xFF, N set, C set
    const program = new Uint8Array([0x3e, 0x01, 0xed, 0x44, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('ED NEG', soft, gate);
    expect(soft.a).toBe(0xff);
    expect(soft.f & 0x02).toBe(0x02);
    expect(soft.f & 0x01).toBe(0x01);
  });

  it('ED LDI / HALT', () => {
    // LD BC,1 / LD DE,0x60 / LD HL,0x50 / LDI / HALT; RAM[0x50]=0x77
    const program = new Uint8Array(128);
    program.set([0x01, 0x01, 0x00, 0x11, 0x60, 0x00, 0x21, 0x50, 0x00, 0xed, 0xa0, 0x76], 0);
    program[0x50] = 0x77;
    const { soft, gate } = runBoth(program, [0x50, 0x60], 16);
    expectParity('ED LDI', soft, gate);
    expect(soft.ram[1]).toBe(0x77);
    expect(soft.hl).toBe(0x51);
    expect(soft.de).toBe(0x61);
    expect(soft.bc).toBe(0);
  });

  it('DD LD IX,nn / HALT', () => {
    const program = new Uint8Array([0xdd, 0x21, 0x34, 0x12, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('DD LD IX,nn', soft, gate);
    expect(soft.ix).toBe(0x1234);
  });

  it('DD INC IX / HALT', () => {
    const program = new Uint8Array([0xdd, 0x21, 0xff, 0x00, 0xdd, 0x23, 0x76]);
    const { soft, gate } = runBoth(program, []);
    expectParity('DD INC IX', soft, gate);
    expect(soft.ix).toBe(0x0100);
  });
});
