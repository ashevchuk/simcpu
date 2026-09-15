import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=00, z=4/z=5: INC r/DEC r (register operands, no (HL))', () => {
  /**
   * Two ADD A,B warm-up instructions establish C=1 first (0+0xFF, then
   * 0xFF+0xFF, the second one genuinely carrying) — every INC/DEC r
   * instruction after that is checked to leave C exactly as those two
   * instructions left it, the concrete assertion that real Z80's "C is
   * untouched by this family" is actually wired that way here, not just
   * documented. Each register then gets INC'd then DEC'd once, chosen to
   * hit a real edge case per register: B wraps 0xFF->0x00->0xFF, D flips
   * its own sign bit 0x7F<->0x80, C's own INC/DEC crosses zero
   * (0x00->0x01->0x00, the one case in this trace where Z actually
   * toggles), E/H/L/A are ordinary cases confirming the shared adder and
   * its flag computation generalize to every register, not just the ones
   * with a special-cased boundary.
   *
   *  0: 0x80  ADD A,B    A <- 0+0xFF = 0xFF; C=0 (no carry yet)
   *  1: 0x80  ADD A,B    A <- 0xFF+0xFF = 0xFE; C=1 (this one carries)
   *  2: 0x0C  INC C      C 0x00->0x01
   *  3: 0x0D  DEC C      C 0x01->0x00 (Z=1 — the only zero result here)
   *  4: 0x04  INC B      B 0xFF->0x00 (wraps)
   *  5: 0x05  DEC B      B 0x00->0xFF (wraps back)
   *  6: 0x14  INC D      D 0x7F->0x80 (sign bit flips, S 0->1)
   *  7: 0x15  DEC D      D 0x80->0x7F (back)
   *  8: 0x1C  INC E      E 0x80->0x81
   *  9: 0x1D  DEC E      E 0x81->0x80
   * 10: 0x24  INC H      H 0x01->0x02
   * 11: 0x25  DEC H      H 0x02->0x01
   * 12: 0x2C  INC L      L 0xFE->0xFF
   * 13: 0x2D  DEC L      L 0xFF->0xFE
   * 14: 0x3C  INC A      A 0xFE->0xFF
   * 15: 0x3D  DEC A      A 0xFF->0xFE
   *
   * Every expected F value below was hand-computed from the real Z80 bit
   * layout (S Z Y H X P/V N C) this project already uses (verified
   * against the x=10 test's own ADD A,B result, F=0x04) — S/Z/H/X/Y
   * freshly computed off each instruction's own result (H/X/Y real now —
   * see "Closing the half-carry gap" in `blocks.ts`, not `gnd` the way
   * they were when this file's own numbers were first derived), N the
   * direction, C copied forward unchanged from whatever the two ADD A,B
   * warm-ups left it at (1, from instruction 1 onward). `P/V` is signed
   * overflow for this entire trace, not parity — `INC r`/`DEC r` (and the
   * `ADD A,B` warm-ups) are purely arithmetic, and this family never gets
   * a parity variant the way `AND`/`OR`/`XOR` do (see "P/V is two flags,
   * not one" in `blocks.ts`); `INC D`/`DEC D` (`0x7F<->0x80`) are this
   * trace's own instance of the textbook signed-overflow case.
   */
  const B0 = 0xff;
  const C0 = 0x00;
  const D0 = 0x7f;
  const E0 = 0x80;
  const H0 = 0x01;
  const L0 = 0xfe;
  const ADDR_BITS = 5;
  const PROGRAM = Uint8Array.from([0x80, 0x80, 0x0c, 0x0d, 0x04, 0x05, 0x14, 0x15, 0x1c, 0x1d, 0x24, 0x25, 0x2c, 0x2d, 0x3c, 0x3d]);

  interface Snapshot {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    h: number;
    l: number;
    f: number;
    pc: number;
  }
  const EXPECTED: Snapshot[] = [
    { a: 0xff, b: 0xff, c: 0x00, d: 0x7f, e: 0x80, h: 0x01, l: 0xfe, f: 0xa8, pc: 1 }, // ADD A,B (C still 0) — A=0xFF: X/Y=1/1; P/V=overflow=0 (0+0xFF doesn't overflow signed)
    { a: 0xfe, b: 0xff, c: 0x00, d: 0x7f, e: 0x80, h: 0x01, l: 0xfe, f: 0xb9, pc: 2 }, // ADD A,B (C now 1) — 0xF+0xF nibble genuinely carries: H=1; A=0xFE: X/Y=1/1; P/V=overflow=0
    { a: 0xfe, b: 0xff, c: 0x01, d: 0x7f, e: 0x80, h: 0x01, l: 0xfe, f: 0x01, pc: 3 }, // INC C — C=0x01: H/X/Y all 0; P/V=overflow=0 (INC/DEC r is always overflow, not parity)
    { a: 0xfe, b: 0xff, c: 0x00, d: 0x7f, e: 0x80, h: 0x01, l: 0xfe, f: 0x43, pc: 4 }, // DEC C (Z=1) — C=0x00: H/X/Y all 0; P/V=overflow=0
    { a: 0xfe, b: 0x00, c: 0x00, d: 0x7f, e: 0x80, h: 0x01, l: 0xfe, f: 0x51, pc: 5 }, // INC B (wraps) — 0xF+1 nibble carries: H=1; B=0x00: X/Y=0/0; P/V=overflow=0
    { a: 0xfe, b: 0xff, c: 0x00, d: 0x7f, e: 0x80, h: 0x01, l: 0xfe, f: 0xbb, pc: 6 }, // DEC B (wraps back) — 0x0-1 borrows: H=1; B=0xFF: X/Y=1/1; P/V=overflow=0
    { a: 0xfe, b: 0xff, c: 0x00, d: 0x80, e: 0x80, h: 0x01, l: 0xfe, f: 0x95, pc: 7 }, // INC D (sign flips) — 0xF+1 nibble carries: H=1; D=0x80: X/Y=0/0; P/V=overflow=1 (0x7F->0x80, the classic signed-overflow case)
    { a: 0xfe, b: 0xff, c: 0x00, d: 0x7f, e: 0x80, h: 0x01, l: 0xfe, f: 0x3f, pc: 8 }, // DEC D — 0x0-1 borrows: H=1; D=0x7F: X/Y=1/1; P/V=overflow=1 (0x80->0x7F, the reverse overflow)
    { a: 0xfe, b: 0xff, c: 0x00, d: 0x7f, e: 0x81, h: 0x01, l: 0xfe, f: 0x81, pc: 9 }, // INC E — E=0x81: H/X/Y all 0; P/V=overflow=0
    { a: 0xfe, b: 0xff, c: 0x00, d: 0x7f, e: 0x80, h: 0x01, l: 0xfe, f: 0x83, pc: 10 }, // DEC E — E=0x80: H/X/Y all 0; P/V=overflow=0
    { a: 0xfe, b: 0xff, c: 0x00, d: 0x7f, e: 0x80, h: 0x02, l: 0xfe, f: 0x01, pc: 11 }, // INC H — H=0x02: H(flag)/X/Y all 0; P/V=overflow=0
    { a: 0xfe, b: 0xff, c: 0x00, d: 0x7f, e: 0x80, h: 0x01, l: 0xfe, f: 0x03, pc: 12 }, // DEC H — H=0x01: H(flag)/X/Y all 0; P/V=overflow=0
    { a: 0xfe, b: 0xff, c: 0x00, d: 0x7f, e: 0x80, h: 0x01, l: 0xff, f: 0xa9, pc: 13 }, // INC L — L=0xFF: X/Y=1/1; P/V=overflow=0
    { a: 0xfe, b: 0xff, c: 0x00, d: 0x7f, e: 0x80, h: 0x01, l: 0xfe, f: 0xab, pc: 14 }, // DEC L — 0xF+0xF nibble carries: H=1; L=0xFE: X/Y=1/1; P/V=overflow=0
    { a: 0xff, b: 0xff, c: 0x00, d: 0x7f, e: 0x80, h: 0x01, l: 0xfe, f: 0xa9, pc: 15 }, // INC A — A=0xFF: X/Y=1/1; P/V=overflow=0
    { a: 0xfe, b: 0xff, c: 0x00, d: 0x7f, e: 0x80, h: 0x01, l: 0xfe, f: 0xab, pc: 16 }, // DEC A — 0xF+0xF nibble carries: H=1; A=0xFE: X/Y=1/1; P/V=overflow=0
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('runs INC/DEC on B/C/D/E/H/L/A, computing S/Z/P/N fresh each time while leaving C exactly where the warm-up ADDs left it', () => {
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
    seedReg(cpu.sp, 16, ADDR_BITS);

    let state = initialState();
    let netMap!: NetMap;
    // Same flatten-once-per-tick reasoning as the other buildZ80Cpu tests —
    // this composite is deeper still now (the shared 8-bit INC/DEC r adder,
    // its own 7-way one-hot read-select tree, F's widened per-bit mux) than
    // any of the earlier ones.
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
      pulse(phaseClk); // -> EXEC1 (single-cycle, like x=10/x=01/x=00's INC rr — EXEC2 is a no-op here too)
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

