import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe("buildZ80Cpu — LD r,r' (x=01): register/register and register/(HL) moves", () => {
  /**
   * A genuine 6-instruction real-Z80 program exercising every distinct
   * shape this group supports: register<-register, register<-A, A<-register
   * already covered above so this focuses on the rest, register<-(HL),
   * (HL)<-register, a same-register no-op (LD B,B), and finally the one
   * deliberately-inert opcode in this whole group, 0x76 (the HALT slot —
   * see buildZ80Cpu's own doc comment for why this slice leaves it inert
   * rather than guessing at LD (HL),(HL) or real HALT semantics).
   *
   *   0x78 = 01_111_000  LD A,B     A <- B = 0x11
   *   0x4F = 01_001_111  LD C,A     C <- A = 0x11        (was 0x22)
   *   0x56 = 01_010_110  LD D,(HL)  D <- RAM[L] = 0x55    (was 0x33)
   *   0x73 = 01_110_011  LD (HL),E  RAM[L] <- E = 0x44    (was 0x55)
   *   0x40 = 01_000_000  LD B,B     B unchanged = 0x11    (same-reg no-op)
   *   0x76 = 01_110_110  (HALT slot, y=z=(HL)) — inert: nothing changes
   *
   * Snapshotting every register (plus RAM[L]) after each step, not just
   * whichever one *should* have changed, so a decode bug that picks the
   * wrong destination or leaves an old write path live shows up as an
   * unexpected field changing, not just an expected one failing to.
   */
  const B0 = 0x11;
  const C0 = 0x22;
  const D0 = 0x33;
  const E0 = 0x44;
  const HL_BYTE = 0x55;
  const HL_ADDR = 8; // past the 6-instruction program (addresses 0-5)
  const PROGRAM = (() => {
    const bytes = new Uint8Array(HL_ADDR + 1);
    bytes.set([0x78, 0x4f, 0x56, 0x73, 0x40, 0x76]);
    bytes[HL_ADDR] = HL_BYTE;
    return bytes;
  })();

  interface Snapshot {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    hl: number;
  }
  const EXPECTED: Snapshot[] = [
    { a: 0x11, b: 0x11, c: 0x22, d: 0x33, e: 0x44, hl: 0x55 }, // LD A,B
    { a: 0x11, b: 0x11, c: 0x11, d: 0x33, e: 0x44, hl: 0x55 }, // LD C,A
    { a: 0x11, b: 0x11, c: 0x11, d: 0x55, e: 0x44, hl: 0x55 }, // LD D,(HL)
    { a: 0x11, b: 0x11, c: 0x11, d: 0x55, e: 0x44, hl: 0x44 }, // LD (HL),E
    { a: 0x11, b: 0x11, c: 0x11, d: 0x55, e: 0x44, hl: 0x44 }, // LD B,B (no-op)
    { a: 0x11, b: 0x11, c: 0x11, d: 0x55, e: 0x44, hl: 0x44 }, // 0x76 (inert)
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('runs LD A,r / LD r,A / LD r,(HL) / LD (HL),r / a same-register no-op / the inert 0x76 slot, snapshotting every register after each', () => {
    const library = new ChipLibrary();
    const parent = new Circuit();
    const cpu = buildZ80Cpu(parent, library, 4, PROGRAM);

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
    const seedReg = (reg: (typeof cpu)['rB'], value: number) => {
      const we = makeInput(parent, 1);
      wire(parent, we.pins.out, reg.we);
      const d = toBits(value, 8).map((bit) => makeInput(parent, bit));
      d.forEach((input, i) => wire(parent, input.pins.out, reg.d[i]!));
      seedIns.push({ we, d });
    };
    seedReg(cpu.rB, B0);
    seedReg(cpu.rC, C0);
    seedReg(cpu.rD, D0);
    seedReg(cpu.rE, E0);
    seedReg(cpu.rH, 0);
    seedReg(cpu.rL, HL_ADDR);

    let state = initialState();
    let netMap!: NetMap;
    // Same reasoning as the x=10 test above: flatten once, let step() do
    // its own deep internal relaxation instead of routing through
    // tickHierarchical's re-flatten-per-pass loop.
    const tick = () => {
      const flat = flatten(parent, library);
      netMap = flat.computeNets();
      state = step(flat, netMap, state, 200);
    };
    const pulse = (sig: { value: 0 | 1 }) => {
      sig.value = 1;
      tick();
      sig.value = 0;
      tick();
    };
    const readReg = (reg: (typeof cpu)['rB']) => fromBits(reg.q.map((q) => levelAt(state, netMap, q.id)));
    const snapshot = (): Snapshot => ({
      a: fromBits(cpu.a.map((q) => levelAt(state, netMap, q.id))),
      b: readReg(cpu.rB),
      c: readReg(cpu.rC),
      d: readReg(cpu.rD),
      e: readReg(cpu.rE),
      hl: cpu.ram.bytes[HL_ADDR]!,
    });

    tick(); // settle with both clocks low

    pulse(phaseClk); // seed the FSM into phase 0 (FETCH)
    fsmLoad.value = 0;

    // PC resets to 0, A resets to 0, and B/C/D/E/H/L get their seeded
    // values — all on the same first pulse (IR's own capture here is
    // garbage, thrown away, same as every other buildMinimalCpu-family
    // test).
    pulse(dataClk);
    resetPulse.value = 0;
    aResetPulse.value = 0;
    for (const s of seedIns) s.we.value = 0;
    pulse(dataClk); // real first fetch: IR <- PROGRAM[0]

    for (let i = 0; i < EXPECTED.length; i++) {
      pulse(phaseClk); // -> INCREMENT
      pulse(dataClk); // PC advances
      pulse(phaseClk); // -> EXEC1
      pulse(dataClk); // the destination register (or RAM[(HL)]) updates from the current IR
      expect(snapshot()).toEqual(EXPECTED[i]);
      pulse(phaseClk); // -> EXEC2 (a genuine no-op for this group — see "x=11: SP, PUSH/POP, RET, RST n")
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC3 (a genuine no-op for this group too — see "x=00, z=1: LD dd,nn")
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC4 (ditto)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC5 (a genuine no-op for this group too — see "x=11: CALL nn")
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC6 (ditto)
      pulse(dataClk);
      pulse(phaseClk); // -> FETCH
      pulse(dataClk); // IR <- next opcode
    }
  });
});

