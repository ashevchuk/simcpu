import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=00: INC (HL)/DEC (HL)/LD (HL),n', () => {
  /**
   * Every write goes through RAM, not a register, so this test's own
   * proof is a genuine round trip: `LD (HL),n` or `INC`/`DEC (HL)`
   * writes, the very next instruction is `LD A,(HL)` (x=01's own already-
   * proven (HL) read) reading the *same* address back into `A` — a
   * mis-wired address mux tap, a write that landed on the wrong phase, or
   * a write that never committed at all would all show up as a wrong `A`
   * immediately, not several instructions later. `0xFF -> INC -> 0x00`
   * and `0x00 -> DEC -> 0xFF` exercise the real 8-bit wraparound in both
   * directions, checked against `F`'s own `Z`/`N`/`S` bits, not just
   * `A`'s own read-back value.
   *
   *  0: 0xAF               XOR A,A       F <- 0x44 (Z=1) — known starting flag state
   *  1: 0x21,0x50,0x00     LD HL,0x0050
   *  4: 0x36,0xFF          LD (HL),0xFF  RAM[0x50] <- 0xFF
   *  6: 0x7E               LD A,(HL)     A <- 0xFF — proves the write landed
   *  7: 0x34               INC (HL)      RAM[0x50] <- 0x00, Z=1 N=0 S=0 (wraps)
   *  8: 0x7E               LD A,(HL)     A <- 0x00
   *  9: 0x34               INC (HL)      RAM[0x50] <- 0x01, Z=0 N=0 S=0
   * 10: 0x7E               LD A,(HL)     A <- 0x01
   * 11: 0x35               DEC (HL)      RAM[0x50] <- 0x00, Z=1 N=1 S=0
   * 12: 0x7E               LD A,(HL)     A <- 0x00
   * 13: 0x35               DEC (HL)      RAM[0x50] <- 0xFF, Z=0 N=1 S=1 (wraps)
   * 14: 0x7E               LD A,(HL)     A <- 0xFF
   * 15: 0x36,0x42          LD (HL),0x42  RAM[0x50] <- 0x42 — a second LD (HL),n, not a fluke
   * 17: 0x7E               LD A,(HL)     A <- 0x42
   */
  const ADDR_BITS = 7;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0xaf], 0);
    bytes.set([0x21, 0x50, 0x00], 1);
    bytes.set([0x36, 0xff], 4);
    bytes.set([0x7e], 6);
    bytes.set([0x34], 7);
    bytes.set([0x7e], 8);
    bytes.set([0x34], 9);
    bytes.set([0x7e], 10);
    bytes.set([0x35], 11);
    bytes.set([0x7e], 12);
    bytes.set([0x35], 13);
    bytes.set([0x7e], 14);
    bytes.set([0x36, 0x42], 15);
    bytes.set([0x7e], 17);
    return bytes;
  })();

  interface Snapshot {
    a: number;
    z: number;
    n: number;
    s: number;
    pc: number;
  }
  const EXPECTED: Snapshot[] = [
    { a: 0x00, z: 1, n: 0, s: 0, pc: 1 }, // XOR A,A
    { a: 0x00, z: 1, n: 0, s: 0, pc: 4 }, // LD HL,0x0050
    { a: 0x00, z: 1, n: 0, s: 0, pc: 6 }, // LD (HL),0xFF
    { a: 0xff, z: 1, n: 0, s: 0, pc: 7 }, // LD A,(HL)
    { a: 0xff, z: 1, n: 0, s: 0, pc: 8 }, // INC (HL) — 0xFF -> 0x00, wraps
    { a: 0x00, z: 1, n: 0, s: 0, pc: 9 }, // LD A,(HL)
    { a: 0x00, z: 0, n: 0, s: 0, pc: 10 }, // INC (HL) — 0x00 -> 0x01
    { a: 0x01, z: 0, n: 0, s: 0, pc: 11 }, // LD A,(HL)
    { a: 0x01, z: 1, n: 1, s: 0, pc: 12 }, // DEC (HL) — 0x01 -> 0x00
    { a: 0x00, z: 1, n: 1, s: 0, pc: 13 }, // LD A,(HL)
    { a: 0x00, z: 0, n: 1, s: 1, pc: 14 }, // DEC (HL) — 0x00 -> 0xFF, wraps
    { a: 0xff, z: 0, n: 1, s: 1, pc: 15 }, // LD A,(HL)
    { a: 0xff, z: 0, n: 1, s: 1, pc: 17 }, // LD (HL),0x42
    { a: 0x42, z: 0, n: 1, s: 1, pc: 18 }, // LD A,(HL)
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('reads (HL), modifies it, and writes it back through real RAM — round-tripped through LD A,(HL) each time', () => {
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
    // every other buildZ80Cpu test in this file already follows.
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
    // this composite is deeper still now (hlMemTemp's and ldHlNImm's own
    // holding registers, the shared r8Adder's eighth read-select term, and
    // two more RAM address-mux override layers).
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
      z: readReg([cpu.f[6]!]),
      n: readReg([cpu.f[1]!]),
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
      pulse(phaseClk); // -> EXEC1 (INC (HL)/DEC (HL) read (HL) here; LD (HL),n reads its own immediate byte here)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC2 (INC (HL)/DEC (HL) and LD (HL),n both commit their own write here)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC3
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC4
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC5
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC6
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
