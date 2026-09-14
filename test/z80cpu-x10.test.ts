import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — decodes and executes real Z80 x=10 opcodes', () => {
  /**
   * A genuine 6-instruction real-Z80 program (opcodes taken straight from
   * a real Z80 reference, not made up for this test): B/C/H/L are seeded
   * directly (this slice implements no instruction that could load them
   * from the program itself), A is reset to 0 (see buildZ80Cpu's own
   * doc comment for why that's necessary here), and RAM holds one extra
   * byte (0x08) past the program, at the address L points to, standing in
   * for "the byte at (HL)".
   *
   *   0x80 = 10_000_000  ADD A,B    A <- 0 + 5 = 5
   *   0x91 = 10_010_001  SUB C      A <- 5 - 2 = 3
   *   0xA0 = 10_100_000  AND B      A <- 3 & 5 = 1     (0b011 & 0b101)
   *   0xA9 = 10_101_001  XOR C      A <- 1 ^ 2 = 3     (0b001 ^ 0b010)
   *   0xB6 = 10_110_110  OR (HL)    A <- 3 | 8 = 11    (0b0011 | 0b1000)
   *   0x87 = 10_000_111  ADD A,A    A <- 11 + 11 = 22  (self-referential:
   *                                 the operand bus and the ALU's own `a`
   *                                 input both read A's current value)
   *
   * Each step mixes a different source register (B, C, B again, C again,
   * memory, A itself) and a different operation, so a decode bug that
   * picked the wrong z line or the wrong y-derived ALU op produces a
   * different, wrong number at that step rather than coincidentally
   * matching — the same "can't pass by accident" property every other
   * program-trace test in this file already relies on.
   */
  const B = 5;
  const C = 2;
  const HL_BYTE = 8;
  const HL_ADDR = 8; // past the 6-instruction program (addresses 0-5)
  const PROGRAM = (() => {
    const bytes = new Uint8Array(HL_ADDR + 1);
    bytes.set([0x80, 0x91, 0xa0, 0xa9, 0xb6, 0x87]);
    bytes[HL_ADDR] = HL_BYTE;
    return bytes;
  })();
  const EXPECTED_A = [5, 3, 1, 3, 11, 22];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('runs ADD/SUB/AND/XOR/OR/ADD across B, C, (HL), and A itself, A tracking the expected value after each', () => {
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
    const fsmD8 = makeInput(parent, 0);
    wire(parent, fsmD8.pins.out, cpu.fsmD[8]!);
    const fsmD9 = makeInput(parent, 0);
    wire(parent, fsmD9.pins.out, cpu.fsmD[9]!);

    // Seed B, C, H, L directly — nothing this slice executes could ever
    // write them from the program itself. Their `clk` is already wired to
    // `cpu.clk` internally; only `we`/`d` are free for a caller to drive.
    const seedIns: { we: ReturnType<typeof makeInput>; d: ReturnType<typeof makeInput>[] }[] = [];
    const seedReg = (reg: (typeof cpu)['rB'], value: number) => {
      const we = makeInput(parent, 1);
      wire(parent, we.pins.out, reg.we);
      const d = toBits(value, 8).map((bit) => {
        const input = makeInput(parent, bit);
        return input;
      });
      d.forEach((input, i) => wire(parent, input.pins.out, reg.d[i]!));
      seedIns.push({ we, d });
    };
    seedReg(cpu.rB, B);
    seedReg(cpu.rC, C);
    seedReg(cpu.rH, 0);
    seedReg(cpu.rL, HL_ADDR);

    let state = initialState();
    let netMap!: NetMap;
    // This composite is deep enough — a 7-source operand bus feeding an
    // 8-bit ripple-carry ALU behind an aReset mux chain — that a single
    // step() call's own default 64-pass relaxation ceiling isn't enough to
    // fully settle it (empirically, correctness kicks in around 100-150
    // internal passes; 200 leaves headroom). Deliberately *not* using the
    // shared tickHierarchical(..., n) here: that helper re-flattens the
    // whole circuit — a full structuredClone — once per outer pass, so
    // raising *its* n multiplies clone cost by n; flattening once and
    // handing step() a larger maxIterations instead (step() already loops
    // internally without re-flattening) reaches the identical settled state
    // in a fraction of the time.
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
    const readA = () => fromBits(cpu.a.map((q) => levelAt(state, netMap, q.id)));

    tick(); // settle with both clocks low

    pulse(phaseClk); // seed the FSM into phase 0 (FETCH)
    fsmLoad.value = 0;

    // PC resets to 0, A resets to 0, and B/C/H/L get their seeded values —
    // all on the same first pulse (IR's own capture here is garbage,
    // thrown away, same as every other buildMinimalCpu-family test).
    pulse(dataClk);
    resetPulse.value = 0;
    aResetPulse.value = 0;
    for (const s of seedIns) s.we.value = 0;
    pulse(dataClk); // real first fetch: IR <- PROGRAM[0]

    for (let i = 0; i < EXPECTED_A.length; i++) {
      pulse(phaseClk); // -> INCREMENT
      pulse(dataClk); // PC advances
      pulse(phaseClk); // -> EXEC1
      pulse(dataClk); // A updates (or, for (HL), RAM is read) from the current IR
      expect(readA()).toBe(EXPECTED_A[i]);
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
      pulse(phaseClk); // -> EXEC7 (no-op — ring widen for DD/FD CB SET/RES/rot)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC8 (ditto)
      pulse(dataClk);
      pulse(phaseClk); // -> FETCH
      pulse(dataClk); // IR <- next opcode
    }
  });
});

