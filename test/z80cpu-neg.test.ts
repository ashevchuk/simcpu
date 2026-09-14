import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=00, z=4: NEG (real 0xED 0x44)', () => {
  /**
   * This retrofit's first non-block `ED`-table opcode — see "x=00, z=4:
   * NEG" in ARCHITECTURE.md. `A<-0-A`, real two's-complement negation,
   * every flag bit fresh (unlike the block families, nothing here is
   * left stale or unmodeled). Three cases, each exercising a genuinely
   * different corner: `0x01` (the ordinary case — a real half-borrow,
   * `S`/`C` set, `P/V` clear), `0x80` (the one value whose negation
   * doesn't fit back into a signed byte — `A` unchanged, `P/V` set,
   * proving overflow isn't just a copy of the arithmetic group's own
   * formula applied blindly), and `0x00` (the one case with no borrow at
   * all — `Z` set, `C` clear).
   *
   * 0: 0x3E,0x01  LD A,0x01  A<-0x01
   * 2: 0xED,0x44  NEG        A<-0xFF; S=1,Z=0,H=1,P/V=0,N=1,C=1
   * 4: 0x3E,0x80  LD A,0x80  A<-0x80
   * 6: 0xED,0x44  NEG        A<-0x80; S=1,Z=0,H=0,P/V=1,N=1,C=1
   * 8: 0x3E,0x00  LD A,0x00  A<-0x00
   * 10: 0xED,0x44 NEG        A<-0x00; S=0,Z=1,H=0,P/V=0,N=1,C=0
   */
  const ADDR_BITS = 7;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0x3e, 0x01], 0);
    bytes.set([0xed, 0x44], 2);
    bytes.set([0x3e, 0x80], 4);
    bytes.set([0xed, 0x44], 6);
    bytes.set([0x3e, 0x00], 8);
    bytes.set([0xed, 0x44], 10);
    return bytes;
  })();

  interface Snapshot {
    a: number;
    f: number;
    pc: number;
  }
  // F bits, LSB first: C,N,P/V,X,H,Y,Z,S. N is always 1 (NEG always
  // subtracts); X/Y mirror the result's own bits 3/5, the same
  // "documented, not unmodeled" treatment the x=10 ALU group's own X/Y
  // already get.
  const EXPECTED: Snapshot[] = [
    { a: 0x01, f: 0, pc: 2 }, // LD A,0x01
    { a: 0xff, f: 0b10111011, pc: 4 }, // NEG: S=1,Y=1,H=1,X=1,N=1,C=1
    { a: 0x80, f: 0b10111011, pc: 6 }, // LD A,0x80 — LD A,n never touches F
    { a: 0x80, f: 0b10000111, pc: 8 }, // NEG: S=1,P/V=1 (overflow),N=1,C=1 — A unchanged
    { a: 0x00, f: 0b10000111, pc: 10 }, // LD A,0x00 — LD A,n never touches F
    { a: 0x00, f: 0b01000010, pc: 12 }, // NEG: Z=1,N=1 only
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }

  it('negates A with a real half-borrow, real overflow on 0x80, and a real zero case', () => {
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
      const d = Array.from({ length: width }, (_, i) => ((value >> i) & 1) as 0 | 1).map((bit) => makeInput(parent, bit));
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
    seedReg(cpu.aP, 0);
    seedReg(cpu.fP, 0);
    seedReg(cpu.bP, 0);
    seedReg(cpu.cP, 0);
    seedReg(cpu.dP, 0);
    seedReg(cpu.eP, 0);
    seedReg(cpu.hP, 0);
    seedReg(cpu.lP, 0);

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
      f: readReg(cpu.f),
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
      for (let i = 0; i < 10; i++) {
        pulse(phaseClk);
        pulse(dataClk);
      }
    };

    for (const expected of EXPECTED) {
      runInstruction();
      expect(snapshot()).toEqual(expected);
    }
  });
});
