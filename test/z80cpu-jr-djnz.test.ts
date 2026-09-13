import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=00: plain JR e and DJNZ e', () => {
  /**
   * Plain `JR` needs only a single unconditional-forward-jump proof — it
   * shares every byte of `JR cc,e`'s own already-proven machinery, minus
   * the condition test itself, so there is nothing new to distrust beyond
   * "the extra AND gate actually fires." `DJNZ` gets the real proof: a
   * genuine 3-iteration loop, decrementing `B` each pass and incrementing
   * `A` in the loop body, checked on *every* pass — not just the final
   * outcome — so a miscounted iteration or an off-by-one exit shows up
   * immediately rather than averaging out. `DJNZ`'s own displacement
   * (`-3`) is negative, the same sign-extension exercise "x=00: JR cc,e"
   * above already insisted on, now reused rather than re-proven from
   * scratch.
   *
   *  0: 0x18,0x02     JR +2         PC <- 4 (unconditional)
   *  2: 0x3E,0xEE     LD A,0xEE     (trap — reached only if JR wrongly didn't jump)
   *  4: 0x06,0x03     LD B,0x03     B <- 3
   *  6: 0x3C          INC A         (loop body) A <- A+1
   *  7: 0x10,0xFD     DJNZ -3       B <- B-1; jump to 6 if B != 0
   *  9: 0x3E,0x77     LD A,0x77     (loop-exit marker — proves the fall-through, once B hits 0, lands exactly here)
   */
  const ADDR_BITS = 8; // djnzAdder's own jump shares jrOffsetAdder — same addrBits >= 8 sign-extension requirement as "x=00: JR cc,e"
  const PROGRAM = (() => {
    const bytes = new Uint8Array(256);
    bytes.set([0x18, 0x02], 0);
    bytes.set([0x3e, 0xee], 2);
    bytes.set([0x06, 0x03], 4);
    bytes.set([0x3c], 6);
    bytes.set([0x10, 0xfd], 7);
    bytes.set([0x3e, 0x77], 9);
    return bytes;
  })();

  interface Snapshot {
    a: number;
    b: number;
    pc: number;
  }
  const EXPECTED: Snapshot[] = [
    { a: 0x00, b: 0x00, pc: 4 }, // JR +2 — unconditional
    { a: 0x00, b: 0x03, pc: 6 }, // LD B,0x03
    { a: 0x01, b: 0x03, pc: 7 }, // INC A (pass 1)
    { a: 0x01, b: 0x02, pc: 6 }, // DJNZ -3 — B: 3->2, nonzero, taken
    { a: 0x02, b: 0x02, pc: 7 }, // INC A (pass 2)
    { a: 0x02, b: 0x01, pc: 6 }, // DJNZ -3 — B: 2->1, nonzero, taken
    { a: 0x03, b: 0x01, pc: 7 }, // INC A (pass 3)
    { a: 0x03, b: 0x00, pc: 9 }, // DJNZ -3 — B: 1->0, zero, NOT taken, fell through
    { a: 0x77, b: 0x00, pc: 11 }, // LD A,0x77 (loop-exit marker)
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('JR always jumps forward; DJNZ decrements B and loops until it hits zero, then falls through', () => {
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

    // Seeded but otherwise irrelevant to this test — same "every register
    // gets a defined seed, even ones this test doesn't touch" discipline
    // every other buildZ80Cpu test in this file already follows, avoiding
    // a floating external-seed sink on C/D/E/H/L/SP. B is seeded 0 here —
    // LD B,0x03 (addr4) overwrites it for real before DJNZ ever reads it.
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
    // this composite is deeper still now (djnzAdder's own live B-1 sum and
    // B's own fourth write-back layer, on top of everything JR cc,e's own
    // test already exercised).
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
      pulse(phaseClk); // -> EXEC1 (read the displacement byte, and for DJNZ, decrement B in the same phase)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC2 (advance PC past it)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC3 (commit: jump if applicable, otherwise a no-op)
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
