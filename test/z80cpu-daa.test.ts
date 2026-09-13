import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=00, z=7, y=4: DAA, plus real H/X/Y for the x=10/x=11 ALU group and INC r/DEC r', () => {
  /**
   * `H` (half-carry, bit 4) and the two undocumented bits (X/Y, bits 3/5)
   * are real now, not `gnd` — this test proves `H` specifically (X/Y aren't
   * independently observable through anything this simulator's decoder
   * exposes, so they're exercised structurally, not asserted on) across
   * three sources: the main ALU group's own `ADD`/`SUB`, `INC r`/`DEC r`'s
   * own `r8Adder`, and `DAA` itself, which *reads* `H` (and `C`, and `A`'s
   * own nibbles) to correct `A` back into valid packed BCD after an 8-bit
   * add or subtract.
   *
   * Three independently hand-verified BCD round-trips, back to back:
   *  - `0x15 + 0x27` (BCD 15+27=42): low-nibble-only correction (`A&0xF>9`
   *    triggers it, not `H` itself — `5+7=0xC`, no nibble carry out of the
   *    *add* itself, so `H` going into `DAA` is 0, yet the correction still
   *    fires correctly off the nibble-value test alone).
   *  - `0x99 + 0x01` (BCD 99+1=100, wraps to 00 with carry): both corrections
   *    fire (`A&0xF>9` AND `A>0x99`), landing on `0x00`/`C=1` — the "carry
   *    out of a BCD digit" case DAA exists for.
   *  - `0x42 - 0x27` (BCD 42-27=15): the subtract direction, correction
   *    driven by `H` itself this time (`2-7` borrows in the low nibble).
   *
   *  0: 0xAF        XOR A,A     A<-0x00, F<-Z=1,H=0,N=0,C=0 (known start)
   *  1: 0x3E,0x15   LD A,0x15   A<-0x15 (flags untouched)
   *  3: 0xC6,0x27   ADD A,0x27  A<-0x3C, H<-0 (5+7=0xC, no nibble carry), C<-0
   *  5: 0x27        DAA         A<-0x42, H<-1, C<-0, N<-0 (unchanged)
   *  6: 0x3E,0x99   LD A,0x99   A<-0x99 (flags untouched)
   *  8: 0xC6,0x01   ADD A,0x01  A<-0x9A, H<-0 (9+1=0xA, no nibble carry), C<-0
   * 10: 0x27        DAA         A<-0x00, H<-1, C<-1, Z<-1, N<-0 (unchanged)
   * 11: 0x3E,0x42   LD A,0x42   A<-0x42 (flags untouched)
   * 13: 0xD6,0x27   SUB A,0x27  A<-0x1B, H<-1 (2-7 borrows), C<-0, N<-1
   * 15: 0x27        DAA         A<-0x15, H<-0, C<-0, N<-1 (unchanged)
   * 16: 0x3E,0x0F   LD A,0x0F   A<-0x0F (flags untouched)
   * 18: 0x3C        INC A       A<-0x10, H<-1 (0xF+1 carries into bit4), C
   *                             held from before (INC never touches it), N<-0
   * 19: 0x3D        DEC A       A<-0x0F, H<-1 (0x0-1 borrows into bit4), C
   *                             still held, N<-1
   */
  const ADDR_BITS = 7;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0xaf], 0);
    bytes.set([0x3e, 0x15], 1);
    bytes.set([0xc6, 0x27], 3);
    bytes.set([0x27], 5);
    bytes.set([0x3e, 0x99], 6);
    bytes.set([0xc6, 0x01], 8);
    bytes.set([0x27], 10);
    bytes.set([0x3e, 0x42], 11);
    bytes.set([0xd6, 0x27], 13);
    bytes.set([0x27], 15);
    bytes.set([0x3e, 0x0f], 16);
    bytes.set([0x3c], 18);
    bytes.set([0x3d], 19);
    return bytes;
  })();

  interface Snapshot {
    a: number;
    c: number;
    h: number;
    n: number;
    z: number;
    s: number;
    pc: number;
  }
  const EXPECTED: Snapshot[] = [
    { a: 0x00, c: 0, h: 0, n: 0, z: 1, s: 0, pc: 1 }, // XOR A,A
    { a: 0x15, c: 0, h: 0, n: 0, z: 1, s: 0, pc: 3 }, // LD A,0x15
    { a: 0x3c, c: 0, h: 0, n: 0, z: 0, s: 0, pc: 5 }, // ADD A,0x27
    { a: 0x42, c: 0, h: 1, n: 0, z: 0, s: 0, pc: 6 }, // DAA
    { a: 0x99, c: 0, h: 1, n: 0, z: 0, s: 0, pc: 8 }, // LD A,0x99
    { a: 0x9a, c: 0, h: 0, n: 0, z: 0, s: 1, pc: 10 }, // ADD A,0x01
    { a: 0x00, c: 1, h: 1, n: 0, z: 1, s: 0, pc: 11 }, // DAA
    { a: 0x42, c: 1, h: 1, n: 0, z: 1, s: 0, pc: 13 }, // LD A,0x42
    { a: 0x1b, c: 0, h: 1, n: 1, z: 0, s: 0, pc: 15 }, // SUB A,0x27
    { a: 0x15, c: 0, h: 0, n: 1, z: 0, s: 0, pc: 16 }, // DAA
    { a: 0x0f, c: 0, h: 0, n: 1, z: 0, s: 0, pc: 18 }, // LD A,0x0F
    { a: 0x10, c: 0, h: 1, n: 0, z: 0, s: 0, pc: 19 }, // INC A
    { a: 0x0f, c: 0, h: 1, n: 1, z: 0, s: 0, pc: 20 }, // DEC A
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('routes H into DAA and corrects A back into valid packed BCD, both directions', () => {
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
      h: readReg([cpu.f[4]!]),
      n: readReg([cpu.f[1]!]),
      z: readReg([cpu.f[6]!]),
      s: readReg([cpu.f[7]!]),
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
      pulse(phaseClk); // -> EXEC1 (immediate-operand ops read their own byte here)
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
