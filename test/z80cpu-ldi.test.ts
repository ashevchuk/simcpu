import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=10, y=4, z=0: LDI (real 0xED 0xA0)', () => {
  /**
   * Real Z80's simplest ED-table instruction, and this project's first —
   * see "x=10, y=4, z=0: LDI" and "The CB/ED/DD/FD prefix mechanism" in
   * ARCHITECTURE.md for the full derivation. `(DE)<-(HL)`, then
   * `HL++`/`DE++`/`BC--`, `N`/`H` reset, `P/V<-(BC-1 != 0)`, `S`/`Z`/`C`
   * left alone. Two back-to-back `LDI`s, not one — the second is the only
   * way to exercise `BC` actually reaching zero (`P/V` correctly dropping
   * to 0), and proves the holding register genuinely lets go of the first
   * transferred byte rather than smearing it into the second.
   *
   * `RAM[0x50]`/`RAM[0x51]` (well clear of the program bytes themselves,
   * the same "far enough away" convention `z80cpu-ex-sphl.test.ts` already
   * establishes) are seeded to two distinct bytes so a mixed-up source or
   * a stale holding-register value shows up as a wrong byte in a specific
   * place, not a coincidental match.
   *
   * 0: 0x01,0x02,0x00  LD BC,0x0002   BC<-2
   * 3: 0x11,0x60,0x00  LD DE,0x0060   DE<-0x60
   * 6: 0x21,0x50,0x00  LD HL,0x0050   HL<-0x50
   * 9: 0xED,0xA0       LDI            RAM[0x60]<-RAM[0x50] (0x77); HL<-0x51, DE<-0x61, BC<-1, P/V<-1 (BC-1=1!=0)
   * 11: 0xED,0xA0      LDI            RAM[0x61]<-RAM[0x51] (0x99); HL<-0x52, DE<-0x62, BC<-0, P/V<-0 (BC-1=0)
   */
  const ADDR_BITS = 7;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0x01, 0x02, 0x00], 0);
    bytes.set([0x11, 0x60, 0x00], 3);
    bytes.set([0x21, 0x50, 0x00], 6);
    bytes.set([0xed, 0xa0], 9);
    bytes.set([0xed, 0xa0], 11);
    bytes.set([0x77], 0x50);
    bytes.set([0x99], 0x51);
    return bytes;
  })();

  interface Snapshot {
    b: number;
    c: number;
    d: number;
    e: number;
    h: number;
    l: number;
    f: number;
    pc: number;
    ram60: number;
    ram61: number;
  }
  // F bits, LSB first: C,N,P/V,X,H,Y,Z,S — every seed register is 0, so C
  // stays 0 the whole way through (LDI never touches it), N/H are always
  // 0 (LDI resets both every time, and nothing before this ever sets
  // them), and P/V is the one bit that actually changes between the two
  // instructions.
  const F_PV_SET = 0b00000100;
  const F_PV_CLEAR = 0b00000000;
  const EXPECTED: Snapshot[] = [
    { b: 0, c: 2, d: 0, e: 0, h: 0, l: 0, f: 0, pc: 3, ram60: 0x00, ram61: 0x00 }, // LD BC,0x0002
    { b: 0, c: 2, d: 0, e: 0x60, h: 0, l: 0, f: 0, pc: 6, ram60: 0x00, ram61: 0x00 }, // LD DE,0x0060
    { b: 0, c: 2, d: 0, e: 0x60, h: 0, l: 0x50, f: 0, pc: 9, ram60: 0x00, ram61: 0x00 }, // LD HL,0x0050
    { b: 0, c: 1, d: 0, e: 0x61, h: 0, l: 0x51, f: F_PV_SET, pc: 11, ram60: 0x77, ram61: 0x00 }, // LDI #1
    { b: 0, c: 0, d: 0, e: 0x62, h: 0, l: 0x52, f: F_PV_CLEAR, pc: 13, ram60: 0x77, ram61: 0x99 }, // LDI #2
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }

  it('copies (HL) to (DE), advances both pointers, decrements BC, and drops P/V to 0 exactly when BC reaches 0', () => {
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
      b: readReg(cpu.rB.q),
      c: readReg(cpu.rC.q),
      d: readReg(cpu.rD.q),
      e: readReg(cpu.rE.q),
      h: readReg(cpu.rH.q),
      l: readReg(cpu.rL.q),
      f: readReg(cpu.f),
      pc: readReg(cpu.pc),
      ram60: cpu.ram.bytes[0x60]!,
      ram61: cpu.ram.bytes[0x61]!,
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
      for (let i = 0; i < 8; i++) {
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
