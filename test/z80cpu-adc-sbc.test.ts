import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=10: ADC/SBC (real carry-in, plus a plain NOP proof)', () => {
  /**
   * `ADC`/`SBC` reuse the exact same adder ADD/SUB already use — the only
   * thing this test has to prove that no earlier `x=10` test did is that
   * `cin` genuinely comes from `F`'s own `C`, not a hardcoded 0/1: `ADC
   * A,B` with `A=0xFF` (from `LD A,0xFF`, which leaves `C=0` stale) rolls
   * over to `0x00` with `C=1` — an ordinary add, no carry-in involved yet.
   * The very next `ADC A,C` (`C` register `=0x00`) is the real proof: with
   * nothing but the *old* `C=1` to add, `A` becomes `0x01`, not `0x00` — a
   * wrong `cin` (stuck at 0) would fail exactly here, not on the first
   * `ADC`. `SBC` gets the identical two-step proof in the borrow direction
   * (`SUB B` first, to land on a known `C=0`, then two `SBC`s chained the
   * same way `ADC`'s own pair is). A plain `NOP` (`0x00`) is folded into
   * the middle of this same sequence — real Z80's own "does absolutely
   * nothing but advance PC" opcode never needed new circuitry (no decode
   * line in this file's `x=00, z=0` column has ever matched `y=0`), so the
   * only thing worth proving is that A/F genuinely don't move underneath
   * it while PC does.
   *
   * 0: 0xAF        XOR A,A    A<-0x00, F<-Z=1,N=0,C=0
   * 1: 0x3E,0xFF   LD A,0xFF  A<-0xFF (flags untouched — Z/C stay stale)
   * 3: 0x88        ADC A,B    B=1: A<-0x00 (wraps), C<-1, Z<-1, N<-0
   * 4: 0x00        NOP        A/F untouched, PC advances by 1
   * 5: 0x89        ADC A,C    C=0, old C=1: A<-0x01, C<-0, Z<-0, N<-0
   * 6: 0x90        SUB B      B=1: A<-0x00, C<-0 (no borrow), Z<-1, N<-1
   * 7: 0x98        SBC A,B    B=1, old C=0: A<-0xFF (borrows), C<-1, N<-1, S<-1
   * 8: 0x99        SBC A,C    C=0, old C=1: A<-0xFE, C<-0, N<-1, S<-1
   */
  const ADDR_BITS = 7;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0xaf], 0);
    bytes.set([0x3e, 0xff], 1);
    bytes.set([0x88], 3);
    bytes.set([0x00], 4);
    bytes.set([0x89], 5);
    bytes.set([0x90], 6);
    bytes.set([0x98], 7);
    bytes.set([0x99], 8);
    return bytes;
  })();

  interface Snapshot {
    a: number;
    c: number;
    n: number;
    z: number;
    s: number;
    pc: number;
  }
  const EXPECTED: Snapshot[] = [
    { a: 0x00, c: 0, n: 0, z: 1, s: 0, pc: 1 }, // XOR A,A
    { a: 0xff, c: 0, n: 0, z: 1, s: 0, pc: 3 }, // LD A,0xFF
    { a: 0x00, c: 1, n: 0, z: 1, s: 0, pc: 4 }, // ADC A,B
    { a: 0x00, c: 1, n: 0, z: 1, s: 0, pc: 5 }, // NOP — untouched
    { a: 0x01, c: 0, n: 0, z: 0, s: 0, pc: 6 }, // ADC A,C
    { a: 0x00, c: 0, n: 1, z: 1, s: 0, pc: 7 }, // SUB B
    { a: 0xff, c: 1, n: 1, z: 0, s: 1, pc: 8 }, // SBC A,B
    { a: 0xfe, c: 0, n: 1, z: 0, s: 1, pc: 9 }, // SBC A,C
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('routes the real carry flag into cin for ADC/SBC, and leaves NOP a true no-op', () => {
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

    // B=1, C=0 are the two operands every ADC/SBC in this program reads —
    // everything else gets the usual "seeded but otherwise irrelevant"
    // defined-zero treatment.
    const seedIns: { we: ReturnType<typeof makeInput>; d: ReturnType<typeof makeInput>[] }[] = [];
    const seedReg = (reg: (typeof cpu)['rB'], value: number, width = 8) => {
      const we = makeInput(parent, 1);
      wire(parent, we.pins.out, reg.we);
      const d = toBits(value, width).map((bit) => makeInput(parent, bit));
      d.forEach((input, i) => wire(parent, input.pins.out, reg.d[i]!));
      seedIns.push({ we, d });
    };
    seedReg(cpu.rB, 1);
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
      pulse(phaseClk); // -> EXEC1 (LD A,n reads its own immediate byte here)
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
