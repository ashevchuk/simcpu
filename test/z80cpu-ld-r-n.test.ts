import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=00, z=6: LD r,n (8-bit immediate, no LD (HL),n)', () => {
  /**
   * The first instruction this project's Z80 slice executes that reads an
   * operand *after* its own opcode byte — see ARCHITECTURE.md's "x=00,
   * z=6: LD r,n" for why that needed no new FSM phase, just PHASE2/PHASE3
   * reused with different semantics (read the operand, then advance PC
   * *again*) instead of "commit, then a no-op" the way every other group
   * uses them. `runInstruction()` below is entirely unchanged from every
   * other buildZ80Cpu test in this file — the same four phaseClk/dataClk
   * pulse pairs (INCREMENT/EXEC1/EXEC2/FETCH) that handle a one-byte
   * instruction handle this two-byte one too, the concrete proof the
   * design needed no new phase.
   *
   * Loads a distinct byte into every register LD r,n covers (`(HL)`
   * excluded), checking after each one that PC has advanced by *two*
   * (past both the opcode and its own immediate byte, not just one) and
   * that every previously-loaded register kept its own value — a wrong
   * PC advance would desync every fetch after the first instruction,
   * which is exactly the failure mode this test is built to catch.
   */
  const PROGRAM = Uint8Array.from([0x06, 0x11, 0x0e, 0x22, 0x16, 0x33, 0x1e, 0x44, 0x26, 0x55, 0x2e, 0x66, 0x3e, 0x77]);
  const ADDR_BITS = 4;

  interface Snapshot {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    h: number;
    l: number;
    pc: number;
  }
  const EXPECTED: Snapshot[] = [
    { a: 0x00, b: 0x11, c: 0x00, d: 0x00, e: 0x00, h: 0x00, l: 0x00, pc: 2 }, // LD B,0x11
    { a: 0x00, b: 0x11, c: 0x22, d: 0x00, e: 0x00, h: 0x00, l: 0x00, pc: 4 }, // LD C,0x22
    { a: 0x00, b: 0x11, c: 0x22, d: 0x33, e: 0x00, h: 0x00, l: 0x00, pc: 6 }, // LD D,0x33
    { a: 0x00, b: 0x11, c: 0x22, d: 0x33, e: 0x44, h: 0x00, l: 0x00, pc: 8 }, // LD E,0x44
    { a: 0x00, b: 0x11, c: 0x22, d: 0x33, e: 0x44, h: 0x55, l: 0x00, pc: 10 }, // LD H,0x55
    { a: 0x00, b: 0x11, c: 0x22, d: 0x33, e: 0x44, h: 0x55, l: 0x66, pc: 12 }, // LD L,0x66
    { a: 0x77, b: 0x11, c: 0x22, d: 0x33, e: 0x44, h: 0x55, l: 0x66, pc: 14 }, // LD A,0x77
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('loads B/C/D/E/H/L/A with their own immediate byte, PC advancing by two each time', () => {
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
    seedReg(cpu.rB, 0);
    seedReg(cpu.rC, 0);
    seedReg(cpu.rD, 0);
    seedReg(cpu.rE, 0);
    seedReg(cpu.rH, 0);
    seedReg(cpu.rL, 0);
    seedReg(cpu.sp, 8, ADDR_BITS);

    let state = initialState();
    let netMap!: NetMap;
    // Same flatten-once-per-tick reasoning as the other buildZ80Cpu tests
    // — this composite is deeper still now (LD r,n's own read-then-advance
    // wiring layered onto PC's, F's, and every register's already-widened
    // conditions).
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
      pulse(phaseClk); // -> INCREMENT (PC past the opcode, onto its own immediate byte)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC1 (LD r,n's own read: RAM(PC) -> the bus -> the target register)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC2 (LD r,n's own second PC advance, past the immediate byte)
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

