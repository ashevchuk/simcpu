import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=00, z=2: indirect loads through (BC)/(DE)/(nn)', () => {
  /**
   * All 8 opcodes, each proven by a genuine round trip through RAM
   * rather than just "the write didn't crash": write a known byte
   * through the addressing mode under test, clear `A` (or `HL`) to a
   * different value in between, then read it back through the *same*
   * addressing mode and check the original byte survived. A wrong
   * address (a mis-wired `BC`/`DE`/`nnAddr` mux tap) shows up as `0x00`
   * on the read-back — RAM defaults to zero everywhere this program
   * never explicitly writes — not a value that might coincidentally
   * still look right.
   *
   *  0: 0x01,0x40,0x00   LD BC,0x0040
   *  3: 0x11,0x50,0x00   LD DE,0x0050
   *  6: 0x3E,0x11        LD A,0x11
   *  8: 0x02             LD (BC),A       RAM[0x40] <- 0x11
   *  9: 0x3E,0x22        LD A,0x22
   * 11: 0x12             LD (DE),A       RAM[0x50] <- 0x22
   * 12: 0x3E,0x00        LD A,0x00       (clear)
   * 14: 0x0A             LD A,(BC)       A <- RAM[0x40] (0x11) — proves LD (BC),A/LD A,(BC) round-trip
   * 15: 0x3E,0x00        LD A,0x00       (clear)
   * 17: 0x1A             LD A,(DE)       A <- RAM[0x50] (0x22) — proves LD (DE),A/LD A,(DE) round-trip
   * 18: 0x3E,0x33        LD A,0x33
   * 20: 0x32,0x60,0x00   LD (nn),A       RAM[0x60] <- 0x33
   * 23: 0x3E,0x00        LD A,0x00       (clear)
   * 25: 0x3A,0x60,0x00   LD A,(nn)       A <- RAM[0x60] (0x33) — proves LD (nn),A/LD A,(nn) round-trip
   * 28: 0x21,0x34,0x12   LD HL,0x1234
   * 31: 0x22,0x70,0x00   LD (nn),HL      RAM[0x70] <- 0x34 (L), RAM[0x71] <- 0x12 (H)
   * 34: 0x21,0x00,0x00   LD HL,0x0000    (clear)
   * 37: 0x2A,0x70,0x00   LD HL,(nn)      HL <- RAM[0x70..71] (0x1234) — proves LD (nn),HL/LD HL,(nn) round-trip
   */
  const ADDR_BITS = 8;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(256);
    bytes.set([0x01, 0x40, 0x00], 0);
    bytes.set([0x11, 0x50, 0x00], 3);
    bytes.set([0x3e, 0x11], 6);
    bytes.set([0x02], 8);
    bytes.set([0x3e, 0x22], 9);
    bytes.set([0x12], 11);
    bytes.set([0x3e, 0x00], 12);
    bytes.set([0x0a], 14);
    bytes.set([0x3e, 0x00], 15);
    bytes.set([0x1a], 17);
    bytes.set([0x3e, 0x33], 18);
    bytes.set([0x32, 0x60, 0x00], 20);
    bytes.set([0x3e, 0x00], 23);
    bytes.set([0x3a, 0x60, 0x00], 25);
    bytes.set([0x21, 0x34, 0x12], 28);
    bytes.set([0x22, 0x70, 0x00], 31);
    bytes.set([0x21, 0x00, 0x00], 34);
    bytes.set([0x2a, 0x70, 0x00], 37);
    return bytes;
  })();

  interface Snapshot {
    a: number;
    h: number;
    l: number;
    pc: number;
  }
  const EXPECTED: Snapshot[] = [
    { a: 0x00, h: 0x00, l: 0x00, pc: 3 }, // LD BC,0x0040
    { a: 0x00, h: 0x00, l: 0x00, pc: 6 }, // LD DE,0x0050
    { a: 0x11, h: 0x00, l: 0x00, pc: 8 }, // LD A,0x11
    { a: 0x11, h: 0x00, l: 0x00, pc: 9 }, // LD (BC),A
    { a: 0x22, h: 0x00, l: 0x00, pc: 11 }, // LD A,0x22
    { a: 0x22, h: 0x00, l: 0x00, pc: 12 }, // LD (DE),A
    { a: 0x00, h: 0x00, l: 0x00, pc: 14 }, // LD A,0x00
    { a: 0x11, h: 0x00, l: 0x00, pc: 15 }, // LD A,(BC)
    { a: 0x00, h: 0x00, l: 0x00, pc: 17 }, // LD A,0x00
    { a: 0x22, h: 0x00, l: 0x00, pc: 18 }, // LD A,(DE)
    { a: 0x33, h: 0x00, l: 0x00, pc: 20 }, // LD A,0x33
    { a: 0x33, h: 0x00, l: 0x00, pc: 23 }, // LD (nn),A
    { a: 0x00, h: 0x00, l: 0x00, pc: 25 }, // LD A,0x00
    { a: 0x33, h: 0x00, l: 0x00, pc: 28 }, // LD A,(nn)
    { a: 0x33, h: 0x12, l: 0x34, pc: 31 }, // LD HL,0x1234
    { a: 0x33, h: 0x12, l: 0x34, pc: 34 }, // LD (nn),HL
    { a: 0x33, h: 0x00, l: 0x00, pc: 37 }, // LD HL,0x0000
    { a: 0x33, h: 0x12, l: 0x34, pc: 40 }, // LD HL,(nn)
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('writes through BC/DE/nn and reads the exact bytes back, proving each address source independently', () => {
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

    // Seeded but otherwise irrelevant to this test — same "every register
    // gets a defined seed, even ones this test doesn't touch" discipline
    // every other buildZ80Cpu test in this file already follows. B/C/D/E
    // get genuinely overwritten by this program's own LD dd,nn bytes
    // before LD (BC),A/LD (DE),A ever read them.
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
    // this composite is deeper still now (nnAddr's own holding register
    // and write-back, nnAddrPlusOne's own live sum, and four more RAM
    // address-mux override layers on top of everything else).
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
      h: readReg(cpu.rH.q),
      l: readReg(cpu.rL.q),
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
      pulse(phaseClk); // -> EXEC1 (register-indirect opcodes commit here; nn's own low byte read, for the 3-byte ones)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC2 (nn's own advance, for the 3-byte ones)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC3 (nn's own high byte read)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC4 (nn's own second advance)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC5 (A's own nn-indexed commit, or HL's own low byte)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC6 (HL's own high byte, for LD (nn),HL/LD HL,(nn) only)
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
