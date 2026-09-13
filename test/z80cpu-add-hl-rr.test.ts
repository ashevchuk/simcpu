import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=00, z=1, y odd: ADD HL,rr', () => {
  /**
   * All four pairs (BC/DE/HL/SP), each checked right after its own
   * instruction rather than just at the end — a miscabled pair-select
   * line would otherwise average out against the others. `ADD HL,HL`
   * doubles the *same* register the adder itself reads from, proving the
   * one-hot pair select doesn't quietly cross-talk with the `a` input.
   * `ADD HL,SP` proves the zero-extension past `addrBits` is real: `SP`
   * here is nowhere near its own top bit, so a broken zero-extension
   * (feeding garbage or a sign-extended 1 into the high bits) would show
   * up as a wrong `HL` immediately. The final `ADD HL,BC` deliberately
   * overflows past 0xFFFF, checking the carry flag actually gets set —
   * every earlier addition in this test stays comfortably under it, so a
   * carry-flag wire that's simply never connected would pass unnoticed
   * without this last case.
   *
   *  0: 0xAF                XOR A,A       F <- 0x44 (C=0) — known starting flag state
   *  1: 0x01,0x03,0x02      LD BC,0x0203
   *  4: 0x11,0x05,0x04      LD DE,0x0405
   *  7: 0x21,0x01,0x00      LD HL,0x0001
   * 10: 0x09                ADD HL,BC     HL <- 0x0204, C=0
   * 11: 0x19                ADD HL,DE     HL <- 0x0609, C=0
   * 12: 0x29                ADD HL,HL     HL <- 0x0C12, C=0
   * 13: 0x31,0xFF,0x00      LD SP,0x00FF
   * 16: 0x39                ADD HL,SP     HL <- 0x0D11, C=0
   * 17: 0x21,0xFF,0xFF      LD HL,0xFFFF
   * 20: 0x09                ADD HL,BC     HL <- 0x0202, C=1 (0xFFFF + 0x0203 overflows 16 bits)
   */
  const ADDR_BITS = 8;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(256);
    bytes.set([0xaf], 0);
    bytes.set([0x01, 0x03, 0x02], 1);
    bytes.set([0x11, 0x05, 0x04], 4);
    bytes.set([0x21, 0x01, 0x00], 7);
    bytes.set([0x09], 10);
    bytes.set([0x19], 11);
    bytes.set([0x29], 12);
    bytes.set([0x31, 0xff, 0x00], 13);
    bytes.set([0x39], 16);
    bytes.set([0x21, 0xff, 0xff], 17);
    bytes.set([0x09], 20);
    return bytes;
  })();

  interface Snapshot {
    h: number;
    l: number;
    c: number;
    pc: number;
  }
  const EXPECTED: Snapshot[] = [
    { h: 0x00, l: 0x00, c: 0, pc: 1 }, // XOR A,A
    { h: 0x00, l: 0x00, c: 0, pc: 4 }, // LD BC,0x0203
    { h: 0x00, l: 0x00, c: 0, pc: 7 }, // LD DE,0x0405
    { h: 0x00, l: 0x01, c: 0, pc: 10 }, // LD HL,0x0001
    { h: 0x02, l: 0x04, c: 0, pc: 11 }, // ADD HL,BC
    { h: 0x06, l: 0x09, c: 0, pc: 12 }, // ADD HL,DE
    { h: 0x0c, l: 0x12, c: 0, pc: 13 }, // ADD HL,HL
    { h: 0x0c, l: 0x12, c: 0, pc: 16 }, // LD SP,0x00FF
    { h: 0x0d, l: 0x11, c: 0, pc: 17 }, // ADD HL,SP
    { h: 0xff, l: 0xff, c: 0, pc: 20 }, // LD HL,0xFFFF
    { h: 0x02, l: 0x02, c: 1, pc: 21 }, // ADD HL,BC — overflows, C set
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('adds BC/DE/HL/SP into HL, a genuine 16-bit carry, touching only the C flag', () => {
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

    // Seeded but otherwise irrelevant to this test — same "every register
    // gets a defined seed, even ones this test doesn't touch" discipline
    // every other buildZ80Cpu test in this file already follows, avoiding
    // a floating external-seed sink on B/C/D/E/H/L/SP. All of B/C/D/E/H/L
    // get genuinely overwritten by this program's own LD dd,nn bytes
    // before ADD HL,rr ever reads them.
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
    // this composite is deeper still now (addHlAdder's own live 16-bit
    // sum, the 4-way pair select feeding it, and H's/L's own fifth
    // write-back layer).
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
      c: readReg([cpu.f[0]!]),
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
      pulse(phaseClk); // -> EXEC1 (ADD HL,rr's own commit fires here; a no-op for every other opcode in this program except where it reads an immediate byte)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC2
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
