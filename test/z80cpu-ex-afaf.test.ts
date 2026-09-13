import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe("buildZ80Cpu — x=00, z=0, y=1: EX AF,AF'", () => {
  /**
   * A real swap, both directions on the same edge — the only way to prove
   * that rather than assume it is to read `A'`/`F'` back directly (exposed
   * on `Z80Cpu` specifically for this), not just `A`/`F`. `A'`/`F'` are
   * seeded to `0x55`/`0x81` (`C=1`, `S=1`, everything else 0) — deliberately
   * distinct from `A`/`F`'s own post-`XOR A,A`/`SCF` values (`0x00`/`C=1,
   * Z=1`), so a swap that silently didn't happen, or copied instead of
   * exchanging, shows up immediately as a wrong value rather than a
   * coincidental match. Two `EX AF,AF'`s in a row is the real proof: the
   * second one must land `A`/`F`/`A'`/`F'` back exactly on their pre-swap
   * values — a one-way copy (either direction) would leave the second
   * `EX AF,AF'` a no-op instead of a genuine reversal.
   *
   * 0: 0xAF   XOR A,A     A<-0x00, F<-Z=1,N=0,C=0,S=0 (P=1 too — even parity of 0 — real ALU behavior, not this test's own concern, but it *is* part of the byte EX AF,AF' swaps whole)
   * 1: 0x37   SCF         C<-1 (A/Z/S/P untouched) — F is now 0x45
   * 2: 0x08   EX AF,AF'   A<-0x55 (old A'), F<-C=1,S=1 (old F'); A'<-0x00, F'<-old F (0x45)
   * 3: 0x08   EX AF,AF'   A<-0x00, F<-0x45 (both back to step 1's values); A'<-0x55, F'<-0x81 (both back to the seed)
   */
  const ADDR_BITS = 7;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0xaf], 0);
    bytes.set([0x37], 1);
    bytes.set([0x08], 2);
    bytes.set([0x08], 3);
    return bytes;
  })();

  interface Snapshot {
    a: number;
    c: number;
    n: number;
    z: number;
    s: number;
    pc: number;
    aP: number;
    fP: number;
  }
  const EXPECTED: Snapshot[] = [
    { a: 0x00, c: 0, n: 0, z: 1, s: 0, pc: 1, aP: 0x55, fP: 0x81 }, // XOR A,A — A'/F' untouched
    { a: 0x00, c: 1, n: 0, z: 1, s: 0, pc: 2, aP: 0x55, fP: 0x81 }, // SCF — A'/F' still untouched
    { a: 0x55, c: 1, n: 0, z: 0, s: 1, pc: 3, aP: 0x00, fP: 0x45 }, // EX AF,AF' — real swap (0x45: old F's P bit, from XOR A,A's own even parity, carried along too)
    { a: 0x00, c: 1, n: 0, z: 1, s: 0, pc: 4, aP: 0x55, fP: 0x81 }, // EX AF,AF' again — back to the start
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it("swaps A/F with A'/F' on one edge, both directions, and reverses cleanly on a second swap", () => {
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

    // A'/F' seeded to 0x55/0x81 — deliberately distinct from A/F's own
    // post-XOR/SCF values, so the swap shows up as a real value change,
    // not a coincidental match. Everything else gets the usual
    // seeded-but-otherwise-irrelevant defined-zero treatment.
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
    seedReg(cpu.sp, 0, ADDR_BITS);
    seedReg(cpu.aP, 0x55);
    seedReg(cpu.fP, 0x81);

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
      c: readReg([cpu.f[0]!]),
      n: readReg([cpu.f[1]!]),
      z: readReg([cpu.f[6]!]),
      s: readReg([cpu.f[7]!]),
      pc: readReg(cpu.pc),
      aP: readReg(cpu.aP.q),
      fP: readReg(cpu.fP.q),
    });

    tick(); // settle with both clocks low

    pulse(phaseClk); // seed the FSM into phase 0 (FETCH)
    fsmLoad.value = 0;

    pulse(dataClk); // PC/A reset, B/C/D/E/H/L/SP/A'/F' seeded
    resetPulse.value = 0;
    aResetPulse.value = 0;
    for (const s of seedIns) s.we.value = 0;
    pulse(dataClk); // real first fetch: IR <- PROGRAM[0]

    const runInstruction = () => {
      pulse(phaseClk); // -> INCREMENT
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC1
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC2 (every op here commits here)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC3
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC4
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC5
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC6
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
