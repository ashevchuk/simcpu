import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe("buildZ80Cpu — x=00, z=3: INC BC/DE/HL/SP, DEC BC/DE/HL/SP", () => {
  /**
   * Exercises all four register pairs in both directions, deliberately
   * choosing seed values that cross the low-byte/high-byte boundary for
   * three of them (BC's own INC, DE's own DEC-from-zero, HL's own
   * INC-from-0xFFFF) — the one thing a naive "just increment the low byte"
   * implementation would get wrong, and the reason each pair gets a real
   * 16-bit ripple-carry `buildAlu` instance rather than two independent
   * 8-bit ones. F is checked after every single instruction and expected
   * to stay exactly what XOR A,A set it to first — real Z80 affects no
   * flags at all for this family, so a flags leak here would be a genuine
   * bug, not a simplification.
   *
   *  0: 0xAF  XOR A,A   A <- 0, F <- 0x44 (Z=1, P=1, rest 0) — same
   *                     computation the x=11 test already verified
   *  1: 0x03  INC BC    BC 0x01FF -> 0x0200 (C 0xFF->0x00 carries into B)
   *  2: 0x0B  DEC BC    BC 0x0200 -> 0x01FF (back — borrow the other way)
   *  3: 0x13  INC DE    DE 0x0000 -> 0x0001
   *  4: 0x1B  DEC DE    DE 0x0001 -> 0x0000 (back)
   *  5: 0x1B  DEC DE    DE 0x0000 -> 0xFFFF (borrow out of a zero pair)
   *  6: 0x23  INC HL    HL 0xFFFF -> 0x0000 (carry out of an all-1s pair)
   *  7: 0x2B  DEC HL    HL 0x0000 -> 0xFFFF (back)
   *  8: 0x33  INC SP    SP 63 -> 0  (6-bit SP, same +-1 spAdder PUSH/POP/
   *                     RET/RST already use, reused rather than duplicated)
   *  9: 0x3B  DEC SP    SP 0  -> 63 (back)
   * 10: 0x3B  DEC SP    SP 63 -> 62 (an ordinary decrement, no wraparound)
   * 11: 0x33  INC SP    SP 62 -> 63 (back)
   */
  const B0 = 0x01;
  const C0 = 0xff;
  const D0 = 0x00;
  const E0 = 0x00;
  const H0 = 0xff;
  const L0 = 0xff;
  const SP0 = 63;
  const ADDR_BITS = 6;
  const PROGRAM = Uint8Array.from([0xaf, 0x03, 0x0b, 0x13, 0x1b, 0x1b, 0x23, 0x2b, 0x33, 0x3b, 0x3b, 0x33]);

  interface Snapshot {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    h: number;
    l: number;
    f: number;
    sp: number;
    pc: number;
  }
  const EXPECTED: Snapshot[] = [
    { a: 0x00, b: 0x01, c: 0xff, d: 0x00, e: 0x00, h: 0xff, l: 0xff, f: 0x44, sp: 63, pc: 1 }, // XOR A,A
    { a: 0x00, b: 0x02, c: 0x00, d: 0x00, e: 0x00, h: 0xff, l: 0xff, f: 0x44, sp: 63, pc: 2 }, // INC BC
    { a: 0x00, b: 0x01, c: 0xff, d: 0x00, e: 0x00, h: 0xff, l: 0xff, f: 0x44, sp: 63, pc: 3 }, // DEC BC
    { a: 0x00, b: 0x01, c: 0xff, d: 0x00, e: 0x01, h: 0xff, l: 0xff, f: 0x44, sp: 63, pc: 4 }, // INC DE
    { a: 0x00, b: 0x01, c: 0xff, d: 0x00, e: 0x00, h: 0xff, l: 0xff, f: 0x44, sp: 63, pc: 5 }, // DEC DE
    { a: 0x00, b: 0x01, c: 0xff, d: 0xff, e: 0xff, h: 0xff, l: 0xff, f: 0x44, sp: 63, pc: 6 }, // DEC DE (borrow)
    { a: 0x00, b: 0x01, c: 0xff, d: 0xff, e: 0xff, h: 0x00, l: 0x00, f: 0x44, sp: 63, pc: 7 }, // INC HL (carry)
    { a: 0x00, b: 0x01, c: 0xff, d: 0xff, e: 0xff, h: 0xff, l: 0xff, f: 0x44, sp: 63, pc: 8 }, // DEC HL
    { a: 0x00, b: 0x01, c: 0xff, d: 0xff, e: 0xff, h: 0xff, l: 0xff, f: 0x44, sp: 0, pc: 9 }, // INC SP (wraps)
    { a: 0x00, b: 0x01, c: 0xff, d: 0xff, e: 0xff, h: 0xff, l: 0xff, f: 0x44, sp: 63, pc: 10 }, // DEC SP (wraps back)
    { a: 0x00, b: 0x01, c: 0xff, d: 0xff, e: 0xff, h: 0xff, l: 0xff, f: 0x44, sp: 62, pc: 11 }, // DEC SP
    { a: 0x00, b: 0x01, c: 0xff, d: 0xff, e: 0xff, h: 0xff, l: 0xff, f: 0x44, sp: 63, pc: 12 }, // INC SP
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('runs INC/DEC on every register pair, carrying and borrowing correctly across the low/high byte boundary, leaving F untouched', () => {
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
    const fsmD8 = makeInput(parent, 0);
    wire(parent, fsmD8.pins.out, cpu.fsmD[8]!);
    const fsmD9 = makeInput(parent, 0);
    wire(parent, fsmD9.pins.out, cpu.fsmD[9]!);

    const seedIns: { we: ReturnType<typeof makeInput>; d: ReturnType<typeof makeInput>[] }[] = [];
    const seedReg = (reg: (typeof cpu)['rB'], value: number, width = 8) => {
      const we = makeInput(parent, 1);
      wire(parent, we.pins.out, reg.we);
      const d = toBits(value, width).map((bit) => makeInput(parent, bit));
      d.forEach((input, i) => wire(parent, input.pins.out, reg.d[i]!));
      seedIns.push({ we, d });
    };
    seedReg(cpu.rB, B0);
    seedReg(cpu.rC, C0);
    seedReg(cpu.rD, D0);
    seedReg(cpu.rE, E0);
    seedReg(cpu.rH, H0);
    seedReg(cpu.rL, L0);
    seedReg(cpu.sp, SP0, ADDR_BITS);

    let state = initialState();
    let netMap!: NetMap;
    // Same flatten-once-per-tick reasoning as the other buildZ80Cpu tests —
    // this composite is deeper still now (three more 16-bit adders, spAdder
    // reused with a widened direction control) than any of the earlier ones.
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
      d: readReg(cpu.rD.q),
      e: readReg(cpu.rE.q),
      h: readReg(cpu.rH.q),
      l: readReg(cpu.rL.q),
      f: readReg(cpu.f),
      sp: readReg(cpu.sp.q),
      pc: readReg(cpu.pc),
    });

    tick(); // settle with both clocks low

    pulse(phaseClk); // seed the FSM into phase 0 (FETCH)
    fsmLoad.value = 0;

    pulse(dataClk); // PC/A reset, B/C/D/E/H/L/SP seeded
    resetPulse.value = 0;
    aResetPulse.value = 0;
    for (const s of seedIns) s.we.value = 0;
    pulse(dataClk); // real first fetch: IR <- PROGRAM[0]

    const runInstruction = () => {
      pulse(phaseClk); // -> INCREMENT
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC1 (this whole family is single-cycle, like x=10/x=01 — EXEC2 is a no-op here too)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC2
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC3 (a genuine no-op for this group too — see "x=00, z=1: LD dd,nn")
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC4 (ditto)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC5 (a genuine no-op for this group too — see "x=11: CALL nn")
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC6 (ditto)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC7 (no-op — ring widen for DD/FD CB SET/RES/rot)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC8 (ditto)
      pulse(dataClk);
      pulse(phaseClk); // -> FETCH (next opcode)
      pulse(dataClk);
    };

    for (const expected of EXPECTED) {
      runInstruction();
      expect(snapshot()).toEqual(expected);
    }
  });
});

