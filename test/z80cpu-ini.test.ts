import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=10, y=4, z=2: INI (real 0xED 0xA2)', () => {
  /**
   * The first instruction of a third `ED`-table column — see "x=10, y=4,
   * z=2: INI" in ARCHITECTURE.md. `(HL)<-IN(C)`: a byte read from this
   * project's own invented I/O port (see "x=11: IN A,(n) / OUT (n),A"),
   * addressed by `C` rather than an immediate byte, written into `(HL)`,
   * then `HL++`, `B--`. Real Z80 documents exactly two flag bits for this
   * whole family: `N` (the transferred byte's own bit 7) and `Z` (`B`
   * reaching `0`) — everything else is famously undocumented territory,
   * not modeled here. Two back-to-back `INI`s, the same "not just one"
   * shape every earlier block-family test in this file already uses, so
   * `B` genuinely reaches `0` on the second — `Z` correctly dropping to
   * `1` exactly then, not staying `0` from the first.
   *
   * The external I/O device is wired to a fixed `0xAB` (`1010 1011` —
   * bit 7 set) for the whole test, the simplest external contract this
   * simulator's own invented port already establishes elsewhere (see
   * "x=11: IN A,(n) / OUT (n),A") — chosen with bit 7 set specifically so
   * `N` reading `1` is a genuine assertion, not a coincidental default.
   *
   * 0: 0x01,0x37,0x02  LD BC,0x0237   BC<-0x0237 (B=2, C=0x37 — the port address, published but not otherwise checked)
   * 3: 0x21,0x10,0x00  LD HL,0x0010   HL<-0x10
   * 6: 0xED,0xA2       INI            RAM[0x10]<-0xAB; HL<-0x11, B<-1, N<-1, Z<-0
   * 8: 0xED,0xA2       INI            RAM[0x11]<-0xAB; HL<-0x12, B<-0, N<-1, Z<-1
   */
  const ADDR_BITS = 7;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0x01, 0x37, 0x02], 0);
    bytes.set([0x21, 0x10, 0x00], 3);
    bytes.set([0xed, 0xa2], 6);
    bytes.set([0xed, 0xa2], 8);
    return bytes;
  })();

  interface Snapshot {
    b: number;
    c: number;
    h: number;
    l: number;
    f: number;
    pc: number;
    ram10: number;
    ram11: number;
  }
  // F bits, LSB first: C,N,P/V,X,H,Y,Z,S — every bit but N/Z stays
  // whatever it started as (0, seeded), since S/H/P/V/C are deliberately
  // not modeled for this family (see the doc comment above).
  const F_B_NONZERO = 0b00000010; // N=1, Z=0 — B still 1
  const F_B_ZERO = 0b01000010; // N=1, Z=1 — B reached 0
  const EXPECTED: Snapshot[] = [
    { b: 2, c: 0x37, h: 0, l: 0, f: 0, pc: 3, ram10: 0x00, ram11: 0x00 }, // LD BC,0x0237
    { b: 2, c: 0x37, h: 0, l: 0x10, f: 0, pc: 6, ram10: 0x00, ram11: 0x00 }, // LD HL,0x0010
    { b: 1, c: 0x37, h: 0, l: 0x11, f: F_B_NONZERO, pc: 8, ram10: 0xab, ram11: 0x00 }, // INI #1
    { b: 0, c: 0x37, h: 0, l: 0x12, f: F_B_ZERO, pc: 10, ram10: 0xab, ram11: 0xab }, // INI #2 — B reaches 0
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }

  it('reads a byte from the port addressed by C into (HL), advances HL, decrements B, and sets N/Z (only)', () => {
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

    // The external I/O device: a fixed 0xAB for the whole test — see the
    // doc comment above for why bit 7 set matters.
    Array.from({ length: 8 }, (_, i) => ((0xab >> i) & 1) as 0 | 1).forEach((bit, i) => {
      const input = makeInput(parent, bit);
      wire(parent, input.pins.out, cpu.ioPortDataIn[i]!);
    });

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
      h: readReg(cpu.rH.q),
      l: readReg(cpu.rL.q),
      f: readReg(cpu.f),
      pc: readReg(cpu.pc),
      ram10: cpu.ram.bytes[0x10]!,
      ram11: cpu.ram.bytes[0x11]!,
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
