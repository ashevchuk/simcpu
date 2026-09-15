import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=11, z=1, y=3: EXX', () => {
  /**
   * The three-pair version of `EX AF,AF'`'s own swap (see
   * z80cpu-ex-afaf.test.ts) — twelve registers, six independent swaps, all
   * on one shared edge. Every one of B/C/D/E/H/L and B'/C'/D'/E'/H'/L' is
   * seeded to its own distinct value (`0x01`..`0x06` for the live set,
   * `0x11`..`0x66` for the shadow set) specifically so a mixed-up pairing
   * (e.g. `D`'s own value landing in `C'` instead of `D'`) would show up as
   * a wrong byte in a specific register, not a coincidental match. Two
   * `EXX`s in a row is the same real proof `EX AF,AF'`'s own test uses: a
   * one-way copy in either direction would leave the second `EXX` a no-op.
   */
  const ADDR_BITS = 7;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0xd9], 0);
    bytes.set([0xd9], 1);
    return bytes;
  })();

  interface Snapshot {
    b: number;
    c: number;
    d: number;
    e: number;
    h: number;
    l: number;
    bP: number;
    cP: number;
    dP: number;
    eP: number;
    hP: number;
    lP: number;
    pc: number;
  }
  const EXPECTED: Snapshot[] = [
    // EXX #1 — live and shadow swap
    { b: 0x11, c: 0x22, d: 0x33, e: 0x44, h: 0x55, l: 0x66, bP: 0x01, cP: 0x02, dP: 0x03, eP: 0x04, hP: 0x05, lP: 0x06, pc: 1 },
    // EXX #2 — back to the seed
    { b: 0x01, c: 0x02, d: 0x03, e: 0x04, h: 0x05, l: 0x06, bP: 0x11, cP: 0x22, dP: 0x33, eP: 0x44, hP: 0x55, lP: 0x66, pc: 2 },
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('swaps B/C/D/E/H/L with their shadow set on one edge, and reverses cleanly on a second EXX', () => {
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
    seedReg(cpu.rB, 0x01);
    seedReg(cpu.rC, 0x02);
    seedReg(cpu.rD, 0x03);
    seedReg(cpu.rE, 0x04);
    seedReg(cpu.rH, 0x05);
    seedReg(cpu.rL, 0x06);
    seedReg(cpu.sp, 0, ADDR_BITS);
    seedReg(cpu.aP, 0);
    seedReg(cpu.fP, 0);
    seedReg(cpu.bP, 0x11);
    seedReg(cpu.cP, 0x22);
    seedReg(cpu.dP, 0x33);
    seedReg(cpu.eP, 0x44);
    seedReg(cpu.hP, 0x55);
    seedReg(cpu.lP, 0x66);

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
      b: readReg(cpu.rB.q),
      c: readReg(cpu.rC.q),
      d: readReg(cpu.rD.q),
      e: readReg(cpu.rE.q),
      h: readReg(cpu.rH.q),
      l: readReg(cpu.rL.q),
      bP: readReg(cpu.bP.q),
      cP: readReg(cpu.cP.q),
      dP: readReg(cpu.dP.q),
      eP: readReg(cpu.eP.q),
      hP: readReg(cpu.hP.q),
      lP: readReg(cpu.lP.q),
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
      pulse(phaseClk); // -> INCREMENT
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC1
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC2 (EXX commits here)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC3
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC4
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC5
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC6
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
