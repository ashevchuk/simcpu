import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=11: JP cc,nn (conditional 16-bit jump)', () => {
  /**
   * No FSM widening needed — this reuses JP nn's exact PHASE2-PHASE5
   * shape, branching only on what PHASE5 itself does (see ARCHITECTURE.md's
   * "x=11: JP cc,nn"). Exercises two condition *pairs* (Z/NZ off one XOR,
   * C/NC off one ADD), each pair with one instruction that should jump and
   * one that shouldn't — proving both `jpCcMux`'s own jump path and
   * `pcHold`'s own fall-through path, not just one of them. Every taken-if
   * -wrong jump target holds a distinct "wrong path" trap (`LD A,0xEE`),
   * the identical discipline "x=11: JP nn"'s own test already established
   * — a jump that fires when it shouldn't, or fails to fire when it
   * should, shows up as a wrong `A`, not just a wrong `PC`.
   *
   *  0: 0xAF            XOR A,A       A <- 0, F <- 0x44 (Z=1, C=0)
   *  1: 0xCA,0x10,0x00  JP Z,0x10     Z=1: taken -> PC <- 0x10
   *  4: 0x3E,0xEE       LD A,0xEE     (trap — reached only if JP Z wrongly didn't jump)
   * 16: 0x3E,0x11       LD A,0x11     A <- 0x11 — proves the jump landed here
   * 18: 0xC2,0x20,0x00  JP NZ,0x20    Z=1 (still, LD doesn't touch flags): NOT taken -> fall through
   * 21: 0x87            ADD A,A       A <- 0x22, F <- 0x04 (Z=0, C=0)
   * 22: 0xDA,0x30,0x00  JP C,0x30     C=0: NOT taken -> fall through
   * 25: 0xD2,0x40,0x00  JP NC,0x40    C=0: taken -> PC <- 0x40
   * 32: 0x3E,0xEE       LD A,0xEE     (trap — reached only if JP NZ wrongly jumped)
   * 48: 0x3E,0xEE       LD A,0xEE     (trap — reached only if JP C wrongly jumped)
   * 64: 0x3E,0x44       LD A,0x44     A <- 0x44 — proves the jump landed here
   */
  const ADDR_BITS = 7;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0xaf], 0);
    bytes.set([0xca, 0x10, 0x00], 1);
    bytes.set([0x3e, 0xee], 4);
    bytes.set([0x3e, 0x11], 16);
    bytes.set([0xc2, 0x20, 0x00], 18);
    bytes.set([0x87], 21);
    bytes.set([0xda, 0x30, 0x00], 22);
    bytes.set([0xd2, 0x40, 0x00], 25);
    bytes.set([0x3e, 0xee], 32);
    bytes.set([0x3e, 0xee], 48);
    bytes.set([0x3e, 0x44], 64);
    return bytes;
  })();

  interface Snapshot {
    a: number;
    pc: number;
  }
  const EXPECTED: Snapshot[] = [
    { a: 0x00, pc: 1 }, // XOR A,A
    { a: 0x00, pc: 0x10 }, // JP Z,0x10 — taken
    { a: 0x11, pc: 18 }, // LD A,0x11 (at the jump target)
    { a: 0x11, pc: 21 }, // JP NZ,0x20 — not taken, fell through
    { a: 0x22, pc: 22 }, // ADD A,A
    { a: 0x22, pc: 25 }, // JP C,0x30 — not taken, fell through
    { a: 0x22, pc: 0x40 }, // JP NC,0x40 — taken
    { a: 0x44, pc: 66 }, // LD A,0x44 (at the jump target)
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('jumps when the tested condition holds and falls through — correctly, not by accident — when it does not', () => {
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

    // Seeded but otherwise irrelevant to this test — same "every register
    // gets a defined seed, even ones this test doesn't touch" discipline
    // every other buildZ80Cpu test in this file already follows, avoiding
    // a floating external-seed sink on B/C/D/E/H/L/SP.
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

    let state = initialState();
    let netMap!: NetMap;
    // Same flatten-once-per-tick reasoning as the other buildZ80Cpu tests —
    // this composite is deeper still now (jpCcTarget's own holding
    // register and its write-back, a fifth mux layer on PC's own
    // retMux/rstMux/jpMux/callMux chain, and the 8-way one-hot condition
    // select feeding it).
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
      pulse(phaseClk); // -> EXEC1
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC2
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
