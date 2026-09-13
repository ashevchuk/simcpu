import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=10, y=5, z=1: CPD (real 0xED 0xA9)', () => {
  /**
   * `CPI`'s mirror image — see "x=10, z=1: CPI/CPD/CPIR/CPDR" in
   * ARCHITECTURE.md. Every flag and the `BC--` land exactly as `CPI`'s
   * own test already proves (shared, dedicated adder — see
   * `z80cpu-cpi.test.ts`); the only thing genuinely new here is that
   * `HL` retreats instead of advancing. Same borrow-then-match shape as
   * `CPI`'s own test, `HL` just seeded near the top of its range and
   * walked downward instead.
   *
   * 0: 0x3E,0x77       LD A,0x77      A<-0x77
   * 2: 0x01,0x02,0x00  LD BC,0x0002   BC<-2
   * 5: 0x21,0x51,0x00  LD HL,0x0051   HL<-0x51
   * 8: 0xED,0xA9       CPD            A-RAM[0x51] (0x77-0x99, borrows); HL<-0x50, BC<-1, P/V<-1
   * 10: 0xED,0xA9      CPD            A-RAM[0x50] (0x77-0x77, matches); HL<-0x4F, BC<-0, P/V<-0
   */
  const ADDR_BITS = 7;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0x3e, 0x77], 0);
    bytes.set([0x01, 0x02, 0x00], 2);
    bytes.set([0x21, 0x51, 0x00], 5);
    bytes.set([0xed, 0xa9], 8);
    bytes.set([0xed, 0xa9], 10);
    bytes.set([0x99], 0x51);
    bytes.set([0x77], 0x50);
    return bytes;
  })();

  interface Snapshot {
    a: number;
    b: number;
    c: number;
    h: number;
    l: number;
    f: number;
    pc: number;
  }
  // Same bit layout and same two flag values as z80cpu-cpi.test.ts — the
  // comparison itself doesn't care which direction HL is moving.
  const F_NOMATCH_BORROW = 0b10010110;
  const F_MATCH_BC_ZERO = 0b01000010;
  const EXPECTED: Snapshot[] = [
    { a: 0x77, b: 0, c: 0, h: 0, l: 0, f: 0, pc: 2 }, // LD A,0x77
    { a: 0x77, b: 0, c: 2, h: 0, l: 0, f: 0, pc: 5 }, // LD BC,0x0002
    { a: 0x77, b: 0, c: 2, h: 0, l: 0x51, f: 0, pc: 8 }, // LD HL,0x0051
    { a: 0x77, b: 0, c: 1, h: 0, l: 0x50, f: F_NOMATCH_BORROW, pc: 10 }, // CPD #1 — no match, a real borrow
    { a: 0x77, b: 0, c: 0, h: 0, l: 0x4f, f: F_MATCH_BC_ZERO, pc: 12 }, // CPD #2 — match, BC reaches 0
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }

  it('compares A against (HL) without writing it, retreats HL, decrements BC, and never touches C', () => {
    const library = new ChipLibrary();
    const parent = new Circuit();
    const cpu = buildZ80Cpu(parent, library, ADDR_BITS, PROGRAM);

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
      state = step(flat, netMap, state, 300);
    };
    const pulse = (sig: { value: 0 | 1 }) => {
      sig.value = 1;
      tick();
      sig.value = 0;
      tick();
    };
    const readReg = (pins: Pin[]) => fromBits(pins.map((p) => levelAt(state, netMap, p.id)));
    const snapshot = (): Snapshot => ({
      a: readReg(cpu.a),
      b: readReg(cpu.rB.q),
      c: readReg(cpu.rC.q),
      h: readReg(cpu.rH.q),
      l: readReg(cpu.rL.q),
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
    pulse(dataClk); // real first fetch: IR <- PROGRAM[0]

    const runInstruction = () => {
      for (let i = 0; i < 8; i++) {
        pulse(phaseClk);
        pulse(dataClk);
      }
    };

    for (const expected of EXPECTED) {
      runInstruction();
      expect(snapshot()).toEqual(expected);
    }
  });
});
