import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=00: JR cc,e (conditional relative jump)', () => {
  /**
   * The proof `JP cc,nn`'s own test already established (jumps when the
   * condition holds, falls through — correctly, not by accident — when it
   * doesn't) plus one this project's other conditional jumps never had to
   * face: real PC-*relative* arithmetic, not a fixed absolute target. A
   * forward-only test would never catch a broken sign-extension (the
   * whole reason `jrOffsetAdder`'s own `b` input needs it at all) — bit 7
   * of a wrong, zero-extended displacement would just add a large
   * *positive* number instead of subtracting a small one, landing
   * somewhere else the trap-byte discipline below would still happen to
   * catch by accident, or might not. So this test includes a genuine
   * *negative* displacement (`JR Z,-5`) jumping backward to a real,
   * already-executed instruction and proving the landing exactly, by
   * re-executing it and checking `A` changes exactly the way running it
   * again should.
   *
   *  0: 0xAF          XOR A,A     A <- 0, F <- 0x44 (Z=1, C=0)
   *  1: 0x28,0x03     JR Z,+3     Z=1: taken -> PC <- 6
   *  3: 0x3E,0xEE     LD A,0xEE   (trap — reached only if JR Z wrongly didn't jump)
   *  6: 0x3E,0x11     LD A,0x11   A <- 0x11 — proves the jump landed here
   *  8: 0x20,0x03     JR NZ,+3    Z=1 (still): NOT taken -> fall through
   * 10: 0x3E,0x22     LD A,0x22   A <- 0x22
   * 12: 0x87          ADD A,A     A <- 0x44, F <- 0x04 (Z=0, C=0)
   * 13: 0x38,0x03     JR C,+3     C=0: NOT taken -> fall through
   * 15: 0x3E,0x33     LD A,0x33   A <- 0x33
   * 17: 0x30,0x03     JR NC,+3    C=0: taken -> PC <- 22
   * 19: 0x3E,0xEE     LD A,0xEE   (trap — reached only if JR NC wrongly didn't jump)
   * 22: 0x3E,0x44     LD A,0x44   A <- 0x44 — proves the jump landed here
   * 24: 0x3E,0x66     LD A,0x66   A <- 0x66 (first pass, forward flow) — also the backward jump's own target
   * 26: 0xAF          XOR A,A     A <- 0, F <- 0x44 (Z=1, C=0)
   * 27: 0x28,0xFB     JR Z,-5     Z=1: taken -> PC <- 24 (backward!)
   *     (re-executes 24: LD A,0x66 — proves the backward landing was exact)
   */
  const ADDR_BITS = 8; // jrOffsetAdder's own sign-extension needs addrBits >= 8 — see "x=00: JR cc,e" above
  const PROGRAM = (() => {
    const bytes = new Uint8Array(256);
    bytes.set([0xaf], 0);
    bytes.set([0x28, 0x03], 1);
    bytes.set([0x3e, 0xee], 3);
    bytes.set([0x3e, 0x11], 6);
    bytes.set([0x20, 0x03], 8);
    bytes.set([0x3e, 0x22], 10);
    bytes.set([0x87], 12);
    bytes.set([0x38, 0x03], 13);
    bytes.set([0x3e, 0x33], 15);
    bytes.set([0x30, 0x03], 17);
    bytes.set([0x3e, 0xee], 19);
    bytes.set([0x3e, 0x44], 22);
    bytes.set([0x3e, 0x66], 24);
    bytes.set([0xaf], 26);
    bytes.set([0x28, 0xfb], 27);
    return bytes;
  })();

  interface Snapshot {
    a: number;
    pc: number;
  }
  const EXPECTED: Snapshot[] = [
    { a: 0x00, pc: 1 }, // XOR A,A
    { a: 0x00, pc: 6 }, // JR Z,+3 — taken
    { a: 0x11, pc: 8 }, // LD A,0x11 (at the jump target)
    { a: 0x11, pc: 10 }, // JR NZ,+3 — not taken, fell through
    { a: 0x22, pc: 12 }, // LD A,0x22
    { a: 0x44, pc: 13 }, // ADD A,A
    { a: 0x44, pc: 15 }, // JR C,+3 — not taken, fell through
    { a: 0x33, pc: 17 }, // LD A,0x33
    { a: 0x33, pc: 22 }, // JR NC,+3 — taken
    { a: 0x44, pc: 24 }, // LD A,0x44 (at the jump target)
    { a: 0x66, pc: 26 }, // LD A,0x66 (forward pass — also the backward jump's own target)
    { a: 0x00, pc: 27 }, // XOR A,A
    { a: 0x00, pc: 24 }, // JR Z,-5 — taken, backward
    { a: 0x66, pc: 26 }, // LD A,0x66 (re-executed — proves the backward landing was exact)
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('jumps by a signed relative displacement when the tested condition holds — forward and backward — and falls through when it does not', () => {
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
    // this composite is deeper still now (jrCcOffset's own capture
    // register, jrOffsetAdder's own live PC-relative sum, and an eighth
    // mux layer, jrCcMux, on PC's own commit chain).
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
      pulse(phaseClk); // -> EXEC1 (read the displacement byte into jrCcOffset)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC2 (advance PC past it — the real base for the relative jump)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC3 (JR cc's own commit: jump if the condition holds, otherwise a no-op)
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
