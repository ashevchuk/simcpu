import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=00, z=1: LD dd,nn (16-bit immediate, BC/DE/HL/SP)', () => {
  /**
   * This slice's first 3-byte instruction, and the first that grows the
   * FSM past 4 phases (EXEC3/EXEC4, see ARCHITECTURE.md's "x=00, z=1: LD
   * dd,nn") — `runInstruction()` below now pulses six phaseClk/dataClk
   * pairs per instruction (INCREMENT/EXEC1/EXEC2/EXEC3/EXEC4/FETCH), not
   * four, the same widening every other buildZ80Cpu test in this file
   * needed too.
   *
   * `LD BC,nn`/`LD DE,nn`/`LD HL,nn` each load a full 16-bit value split
   * across their own two independent registers (low byte -> C/E/L, high
   * byte -> B/D/H — real Z80's own imm16 byte order, low byte first in
   * memory). `LD SP,nn` is checked separately: `SP` is one `addrBits`-wide
   * register here, not two 8-bit ones, and `addrBits` (5, deliberately
   * narrower than a real 16-bit `SP`) truncates the loaded value — this
   * test's own `nn` (`0x1234`) is chosen so truncation touches bits
   * *inside* the low byte too (`0x34 & 0x1F = 0x14`), not just "the high
   * byte is ignored" — the concrete proof the per-bit write-back loop
   * really does stop at `addrBits`, not at an 8-bit boundary.
   *
   *  0: 0x01,0x34,0x12  LD BC,0x1234   B<-0x12, C<-0x34
   *  3: 0x11,0x78,0x56  LD DE,0x5678   D<-0x56, E<-0x78
   *  6: 0x21,0xBC,0x9A  LD HL,0x9ABC   H<-0x9A, L<-0xBC
   *  9: 0x31,0x34,0x12  LD SP,0x1234   SP<-0x1234 & 0x1F = 0x14 (5-bit `addrBits`)
   */
  const ADDR_BITS = 5;
  const PROGRAM = Uint8Array.from([0x01, 0x34, 0x12, 0x11, 0x78, 0x56, 0x21, 0xbc, 0x9a, 0x31, 0x34, 0x12]);

  interface Snapshot {
    b: number;
    c: number;
    d: number;
    e: number;
    h: number;
    l: number;
    sp: number;
    pc: number;
  }
  const EXPECTED: Snapshot[] = [
    { b: 0x12, c: 0x34, d: 0x00, e: 0x00, h: 0x00, l: 0x00, sp: 0, pc: 3 }, // LD BC,0x1234
    { b: 0x12, c: 0x34, d: 0x56, e: 0x78, h: 0x00, l: 0x00, sp: 0, pc: 6 }, // LD DE,0x5678
    { b: 0x12, c: 0x34, d: 0x56, e: 0x78, h: 0x9a, l: 0xbc, sp: 0, pc: 9 }, // LD HL,0x9ABC
    { b: 0x12, c: 0x34, d: 0x56, e: 0x78, h: 0x9a, l: 0xbc, sp: 0x14, pc: 12 }, // LD SP,0x1234 (truncated)
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('loads BC/DE/HL with a full 16-bit immediate and SP with a truncated one, PC advancing by three each time', () => {
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
    // Same flatten-once-per-tick reasoning as the other buildZ80Cpu tests —
    // this composite is deeper still now (the 6-phase FSM, LD dd,nn's own
    // low/high write-back on every register including SP's own five-layer
    // write-back).
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
      sp: readReg(cpu.sp.q),
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
      pulse(phaseClk); // -> INCREMENT (PC past the opcode, onto its own low immediate byte)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC1 (read the low byte, write it into the pair's low half)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC2 (advance PC again, onto the high immediate byte)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC3 (read the high byte, write it into the pair's high half)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC4 (advance PC a third time, past both immediate bytes)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC5 (a genuine no-op for this group too — see "x=11: CALL nn")
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC6 (ditto)
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

