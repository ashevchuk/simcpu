import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=11, z=1, y=5/y=7: JP (HL) / LD SP,HL', () => {
  /**
   * Both are single-byte, no-operand, no-RAM-read commits straight off
   * `HL`'s own current bits — the cheapest possible proof is a real jump
   * and a real stack-pointer change, not just a snapshot showing the right
   * number. `JP (HL)` jumps to `0x10`, a `LD HL,nn` sitting there that
   * would never execute by falling through PC's own normal +1 advance
   * (the bytes in between are never valid opcodes for what they'd
   * decode as if reached in sequence) — landing on the right *value*
   * there afterward is the proof the jump actually happened, not a
   * fallthrough that coincidentally read the same byte. `LD SP,HL` then
   * loads `SP` from that freshly-loaded `HL`, checked by reading `SP`
   * directly.
   *
   *  0: 0x21,0x10,0x00   LD HL,0x0010   HL<-0x0010
   *  3: 0xE9             JP (HL)        PC<-0x10 (jumps to offset 16)
   * 16: 0x21,0x7F,0x00   LD HL,0x007F   HL<-0x007F
   * 19: 0xF9             LD SP,HL       SP<-0x7F
   */
  const ADDR_BITS = 7;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0x21, 0x10, 0x00], 0);
    bytes.set([0xe9], 3);
    bytes.set([0x21, 0x7f, 0x00], 16);
    bytes.set([0xf9], 19);
    return bytes;
  })();

  interface Snapshot {
    h: number;
    l: number;
    sp: number;
    pc: number;
  }
  const EXPECTED: Snapshot[] = [
    { h: 0x00, l: 0x10, sp: 0, pc: 3 }, // LD HL,0x0010
    { h: 0x00, l: 0x10, sp: 0, pc: 16 }, // JP (HL) — real jump, not a fallthrough
    { h: 0x00, l: 0x7f, sp: 0, pc: 19 }, // LD HL,0x007F
    { h: 0x00, l: 0x7f, sp: 0x7f, pc: 20 }, // LD SP,HL
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('JP (HL) jumps to a real address, and LD SP,HL loads SP straight from HL', () => {
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
      h: readReg(cpu.rH.q),
      l: readReg(cpu.rL.q),
      sp: readReg(cpu.sp.q),
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
      pulse(phaseClk); // -> INCREMENT
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC1 (LD HL,nn reads its own low byte here)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC2 (JP (HL)/LD SP,HL commit here; LD HL,nn advances/reads its high byte around here too)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC3 (LD HL,nn's own high-byte commit)
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
