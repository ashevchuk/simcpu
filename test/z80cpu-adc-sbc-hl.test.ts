import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

/**
 * `ADC HL,rr`/`SBC HL,rr` — see "x=01, z=2: ADC HL,rr/SBC HL,rr" in
 * ARCHITECTURE.md. Reuses `ADD HL,rr`'s own shared 16-bit adder, widened
 * for a real carry-in and a real operand invert, and — unlike plain
 * `ADD HL,rr`'s own C-only treatment — computes every flag bit fresh,
 * the identical full-flags shape `NEG` and the `x=10` ALU group already
 * establish. Four cases, each a genuinely different corner: an ordinary
 * add with no flags set at all, a signed overflow on `ADC` (`0x7FFF+1`),
 * a signed overflow on `SBC` the other way (`0x8000-1`), and a real
 * borrow with a real starting carry (`0-0-1`) — plus a fifth case,
 * `ADC HL,HL` with a starting carry, the one pair whose own low/high
 * halves are the identical registers being read twice at once, genuinely
 * wrapping past `0xFFFF` back to `1`.
 */
describe('buildZ80Cpu — x=01, z=2: ADC HL,rr/SBC HL,rr', () => {
  const ADDR_BITS = 7;

  interface Snapshot {
    hl: number;
    f: number;
    pc: number;
  }

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }

  function run(program: Uint8Array, expected: Snapshot[]) {
    const library = new ChipLibrary();
    const parent = new Circuit();
    const cpu = buildZ80Cpu(parent, library, ADDR_BITS, program);

    const resetPulse = makeInput(parent, 1);
    wire(parent, resetPulse.pins.out, cpu.reset);
    const aResetPulse = makeInput(parent, 1);
    wire(parent, aResetPulse.pins.out, cpu.aReset);
    const dataClk = makeInput(parent, 0);
    wire(parent, dataClk.pins.out, cpu.clk);
    const phaseClk = makeInput(parent, 0);
    wire(parent, phaseClk.pins.out, cpu.phaseClk);
    const fsmLoad = makeInput(parent, 1);
    wire(parent, fsmLoad.pins.out, cpu.fsmLoad);
    const fsmD0 = makeInput(parent, 1);
    wire(parent, fsmD0.pins.out, cpu.fsmD[0]!);
    const fsmD1 = makeInput(parent, 0);
    wire(parent, fsmD1.pins.out, cpu.fsmD[1]!);
    const fsmD2 = makeInput(parent, 0);
    wire(parent, fsmD2.pins.out, cpu.fsmD[2]!);
    const fsmD3 = makeInput(parent, 0);
    wire(parent, fsmD3.pins.out, cpu.fsmD[3]!);
    const fsmD4 = makeInput(parent, 0);
    wire(parent, fsmD4.pins.out, cpu.fsmD[4]!);
    const fsmD5 = makeInput(parent, 0);
    wire(parent, fsmD5.pins.out, cpu.fsmD[5]!);
    const fsmD6 = makeInput(parent, 0);
    wire(parent, fsmD6.pins.out, cpu.fsmD[6]!);
    const fsmD7 = makeInput(parent, 0);
    wire(parent, fsmD7.pins.out, cpu.fsmD[7]!);

    const seedIns: { we: ReturnType<typeof makeInput>; d: ReturnType<typeof makeInput>[] }[] = [];
    const seedReg = (reg: (typeof cpu)['rB'], value: number, width = 8) => {
      const we = makeInput(parent, 1);
      wire(parent, we.pins.out, reg.we);
      const d = Array.from({ length: width }, (_, i) => ((value >> i) & 1) as 0 | 1).map((bit) => makeInput(parent, bit));
      d.forEach((input, i) => wire(parent, input.pins.out, reg.d[i]!));
      seedIns.push({ we, d });
    };
    seedReg(cpu.rB, 0);
    seedReg(cpu.rC, 0);
    seedReg(cpu.rD, 0);
    seedReg(cpu.rE, 0);
    seedReg(cpu.rH, 0);
    seedReg(cpu.rL, 0);
    seedReg(cpu.sp, 0, ADDR_BITS);
    seedReg(cpu.aP, 0);
    seedReg(cpu.fP, 0);
    seedReg(cpu.bP, 0);
    seedReg(cpu.cP, 0);
    seedReg(cpu.dP, 0);
    seedReg(cpu.eP, 0);
    seedReg(cpu.hP, 0);
    seedReg(cpu.lP, 0);

    let state = initialState();
    let netMap!: NetMap;
    const tick = () => {
      const flat = flatten(parent, library);
      netMap = flat.computeNets();
      state = step(flat, netMap, state, 400);
    };
    const pulse = (sig: { value: 0 | 1 }) => {
      sig.value = 1;
      tick();
      sig.value = 0;
      tick();
    };
    const readReg = (pins: Pin[]) => fromBits(pins.map((p) => levelAt(state, netMap, p.id)));
    const snapshot = (): Snapshot => ({
      hl: readReg(cpu.rH.q) * 256 + readReg(cpu.rL.q),
      f: readReg(cpu.f),
      pc: readReg(cpu.pc),
    });

    tick(); // settle with both clocks low

    pulse(phaseClk); // seed the FSM into phase 0 (FETCH)
    fsmLoad.value = 0;

    pulse(dataClk); // PC/A reset, every register above seeded
    resetPulse.value = 0;
    aResetPulse.value = 0;
    for (const s of seedIns) s.we.value = 0;
    pulse(dataClk); // real first fetch: IR <- program[0]

    const runInstruction = () => {
      for (let i = 0; i < 8; i++) {
        pulse(phaseClk);
        pulse(dataClk);
      }
    };

    for (const step of expected) {
      runInstruction();
      expect(snapshot()).toEqual(step);
    }
  }

  // F bits, LSB first: C,N,P/V,X,H,Y,Z,S.

  it('ADC HL,BC with no carry in and no flags set', () => {
    const program = new Uint8Array(128);
    program.set([0x21, 0x02, 0x00], 0); // LD HL,0x0002
    program.set([0x01, 0x03, 0x00], 3); // LD BC,0x0003
    program.set([0xed, 0x4a], 6); // ADC HL,BC

    run(program, [
      { hl: 0x0002, f: 0, pc: 3 },
      { hl: 0x0002, f: 0, pc: 6 },
      { hl: 0x0005, f: 0b00000000, pc: 8 },
    ]);
  });

  it('ADC HL,BC with a real signed overflow (0x7FFF+1)', () => {
    const program = new Uint8Array(128);
    program.set([0x21, 0xff, 0x7f], 0); // LD HL,0x7FFF
    program.set([0x01, 0x01, 0x00], 3); // LD BC,0x0001
    program.set([0xed, 0x4a], 6); // ADC HL,BC

    run(program, [
      { hl: 0x7fff, f: 0, pc: 3 },
      { hl: 0x7fff, f: 0, pc: 6 },
      { hl: 0x8000, f: 0b10010100, pc: 8 }, // S=1,H=1,P/V=1,N=0,C=0
    ]);
  });

  it('SBC HL,BC with a real signed overflow (0x8000-1)', () => {
    const program = new Uint8Array(128);
    program.set([0x21, 0x00, 0x80], 0); // LD HL,0x8000
    program.set([0x01, 0x01, 0x00], 3); // LD BC,0x0001
    program.set([0xed, 0x42], 6); // SBC HL,BC

    run(program, [
      { hl: 0x8000, f: 0, pc: 3 },
      { hl: 0x8000, f: 0, pc: 6 },
      { hl: 0x7ffe, f: 0b00111110, pc: 8 }, // S=0,H=1,P/V=1,X=1,Y=1,N=1,C=0
    ]);
  });

  it('SBC HL,BC with a starting carry produces a real borrow (0-0-1)', () => {
    const program = new Uint8Array(128);
    program.set([0x21, 0x00, 0x00], 0); // LD HL,0x0000
    program.set([0x01, 0x00, 0x00], 3); // LD BC,0x0000
    program.set([0x37], 6); // SCF — C<-1
    program.set([0xed, 0x42], 7); // SBC HL,BC

    run(program, [
      { hl: 0x0000, f: 0, pc: 3 },
      { hl: 0x0000, f: 0, pc: 6 },
      { hl: 0x0000, f: 0b00000001, pc: 7 }, // SCF: C=1 only
      { hl: 0xffff, f: 0b10111011, pc: 9 }, // S=1,H=1,P/V=0,X=1,Y=1,N=1,C=1
    ]);
  });

  it('ADC HL,HL with a starting carry wraps past 0xFFFF back to 1', () => {
    const program = new Uint8Array(128);
    program.set([0x21, 0x00, 0x80], 0); // LD HL,0x8000
    program.set([0x37], 3); // SCF — C<-1
    program.set([0xed, 0x6a], 4); // ADC HL,HL

    run(program, [
      { hl: 0x8000, f: 0, pc: 3 },
      { hl: 0x8000, f: 0b00000001, pc: 4 }, // SCF: C=1 only
      { hl: 0x0001, f: 0b00000101, pc: 6 }, // S=0,H=0,P/V=1,N=0,C=1 — real carry out
    ]);
  });
});
