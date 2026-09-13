import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — P/V: signed overflow for arithmetic, parity for logic', () => {
  /**
   * `P/V` is two different flags real Z80 crams into one bit, picked by
   * which op actually ran: parity for `AND`/`OR`/`XOR`, signed two's-
   * complement overflow for `ADD`/`ADC`/`SUB`/`SBC`/`CP` and for `INC r`/
   * `DEC r` (always overflow for that family — it has no logic variant).
   * Overflow itself is the textbook `XOR(carry into the sign bit, carry
   * out of the sign bit)` identity, proven here with the three canonical
   * signed-overflow cases every architecture course uses (`127+1`,
   * `127+127`, `-128-1`), plus one ordinary non-overflowing add and one
   * ordinary non-overflowing `INC` to prove the flag genuinely clears too
   * — not just fires once and gets stuck at 1.
   *
   *  0: 0xAF        XOR A,A     A<-0x00, P=1 (parity, 0 is even)
   *  1: 0x3E,0x7F   LD A,0x7F   A<-0x7F
   *  3: 0xC6,0x01   ADD A,0x01  A<-0x80, P/V<-1 (127+1 overflows)
   *  5: 0x3E,0x7F   LD A,0x7F   A<-0x7F
   *  7: 0xC6,0x7F   ADD A,0x7F  A<-0xFE, P/V<-1 (127+127 overflows)
   *  9: 0x3E,0x80   LD A,0x80   A<-0x80
   * 11: 0xD6,0x01   SUB A,0x01  A<-0x7F, P/V<-1 (-128-1 overflows)
   * 13: 0x3E,0x01   LD A,0x01   A<-0x01
   * 15: 0xC6,0x01   ADD A,0x01  A<-0x02, P/V<-0 (no overflow)
   * 17: 0xE6,0xFF   AND 0xFF    A<-0x02 (unchanged), P<-0 (parity of 0x02, odd)
   * 19: 0xF6,0x01   OR 0x01     A<-0x03, P<-1 (parity of 0x03, even)
   * 21: 0x3E,0x7F   LD A,0x7F   A<-0x7F
   * 23: 0x3C        INC A       A<-0x80, P/V<-1 (INC 0x7F->0x80 overflows)
   * 24: 0x3D        DEC A       A<-0x7F, P/V<-1 (DEC 0x80->0x7F overflows back)
   * 25: 0x3E,0x01   LD A,0x01   A<-0x01
   * 27: 0x3C        INC A       A<-0x02, P/V<-0 (ordinary INC, no overflow)
   */
  const ADDR_BITS = 7;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0xaf], 0);
    bytes.set([0x3e, 0x7f], 1);
    bytes.set([0xc6, 0x01], 3);
    bytes.set([0x3e, 0x7f], 5);
    bytes.set([0xc6, 0x7f], 7);
    bytes.set([0x3e, 0x80], 9);
    bytes.set([0xd6, 0x01], 11);
    bytes.set([0x3e, 0x01], 13);
    bytes.set([0xc6, 0x01], 15);
    bytes.set([0xe6, 0xff], 17);
    bytes.set([0xf6, 0x01], 19);
    bytes.set([0x3e, 0x7f], 21);
    bytes.set([0x3c], 23);
    bytes.set([0x3d], 24);
    bytes.set([0x3e, 0x01], 25);
    bytes.set([0x3c], 27);
    return bytes;
  })();

  interface Snapshot {
    a: number;
    p: number;
    pc: number;
  }
  const EXPECTED: Snapshot[] = [
    { a: 0x00, p: 1, pc: 1 }, // XOR A,A
    { a: 0x7f, p: 1, pc: 3 }, // LD A,0x7F (P held)
    { a: 0x80, p: 1, pc: 5 }, // ADD A,0x01 — 127+1 overflows
    { a: 0x7f, p: 1, pc: 7 }, // LD A,0x7F (P held)
    { a: 0xfe, p: 1, pc: 9 }, // ADD A,0x7F — 127+127 overflows
    { a: 0x80, p: 1, pc: 11 }, // LD A,0x80 (P held)
    { a: 0x7f, p: 1, pc: 13 }, // SUB A,0x01 — -128-1 overflows
    { a: 0x01, p: 1, pc: 15 }, // LD A,0x01 (P held)
    { a: 0x02, p: 0, pc: 17 }, // ADD A,0x01 — no overflow
    { a: 0x02, p: 0, pc: 19 }, // AND 0xFF — parity of 0x02 (odd)
    { a: 0x03, p: 1, pc: 21 }, // OR 0x01 — parity of 0x03 (even)
    { a: 0x7f, p: 1, pc: 23 }, // LD A,0x7F (P held)
    { a: 0x80, p: 1, pc: 24 }, // INC A — 0x7F->0x80 overflows
    { a: 0x7f, p: 1, pc: 25 }, // DEC A — 0x80->0x7F overflows back
    { a: 0x01, p: 1, pc: 27 }, // LD A,0x01 (P held)
    { a: 0x02, p: 0, pc: 28 }, // INC A — ordinary, no overflow
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('picks overflow for arithmetic ops and INC/DEC r, parity for logic ops', () => {
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
      p: readReg([cpu.f[2]!]),
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
