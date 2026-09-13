import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

/**
 * `INIR`/`INDR` — see "x=10, z=2: INI/IND/INIR/INDR" in ARCHITECTURE.md.
 * The port transfer, the flags, and the pointer direction are already
 * `INI`/`IND`'s own machinery (`z80cpu-ini.test.ts` / `z80cpu-ind.test.ts`);
 * the one thing genuinely new here is the repeat condition, and it's the
 * simplest of this file's three: real Z80 stops purely when `B` reaches
 * `0`, no "found it" concept the way `CPIR`/`CPDR` also has to watch for.
 * `B` seeded to `2` so the transfer runs exactly twice — the first
 * `runInstruction()` pass must show `PC` landed back on the `ED`
 * opcode's own address, the second must show it advanced two bytes past
 * it.
 */
describe('buildZ80Cpu — x=10, z=2: INIR/INDR (repeat mechanism)', () => {
  const ADDR_BITS = 7;

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
  const F_B_NONZERO = 0b00000010;
  const F_B_ZERO = 0b01000010;

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }

  function run(program: Uint8Array, expected: Snapshot[]) {
    const library = new ChipLibrary();
    const parent = new Circuit();
    const cpu = buildZ80Cpu(parent, library, ADDR_BITS, program);

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
    pulse(dataClk); // real first fetch: IR <- program[0]

    const runInstruction = () => {
      for (let i = 0; i < 8; i++) {
        pulse(phaseClk);
        pulse(dataClk);
      }
    };

    for (const step of expected) {
      runInstruction();
      expect(snapshot()).toEqual(step);
    }
  }

  it('INIR walks HL upward and lands PC back on its own opcode until B reaches 0', () => {
    /**
     * 0: 0x01,0x00,0x02  LD BC,0x0200   BC<-0x0200 (B=2, C=0 — the port address)
     * 3: 0x21,0x10,0x00  LD HL,0x0010   HL<-0x10
     * 6: 0xED,0xB2       INIR           RAM[0x10]<-0xAB; HL<-0x11,B<-1; PC<-6 (repeats)
     * 6: 0xED,0xB2       INIR (again)   RAM[0x11]<-0xAB; HL<-0x12,B<-0; PC<-8 (falls through)
     */
    const program = new Uint8Array(128);
    program.set([0x01, 0x00, 0x02], 0);
    program.set([0x21, 0x10, 0x00], 3);
    program.set([0xed, 0xb2], 6);

    run(program, [
      { b: 2, c: 0, h: 0, l: 0, f: 0, pc: 3, ram10: 0x00, ram11: 0x00 }, // LD BC,0x0200
      { b: 2, c: 0, h: 0, l: 0x10, f: 0, pc: 6, ram10: 0x00, ram11: 0x00 }, // LD HL,0x0010
      { b: 1, c: 0, h: 0, l: 0x11, f: F_B_NONZERO, pc: 6, ram10: 0xab, ram11: 0x00 }, // INIR pass 1 — repeats
      { b: 0, c: 0, h: 0, l: 0x12, f: F_B_ZERO, pc: 8, ram10: 0xab, ram11: 0xab }, // INIR pass 2 — falls through
    ]);
  });

  it('INDR walks HL downward and lands PC back on its own opcode until B reaches 0', () => {
    /**
     * 0: 0x01,0x00,0x02  LD BC,0x0200   BC<-0x0200 (B=2, C=0 — the port address)
     * 3: 0x21,0x11,0x00  LD HL,0x0011   HL<-0x11
     * 6: 0xED,0xBA       INDR           RAM[0x11]<-0xAB; HL<-0x10,B<-1; PC<-6 (repeats)
     * 6: 0xED,0xBA       INDR (again)   RAM[0x10]<-0xAB; HL<-0x0F,B<-0; PC<-8 (falls through)
     */
    const program = new Uint8Array(128);
    program.set([0x01, 0x00, 0x02], 0);
    program.set([0x21, 0x11, 0x00], 3);
    program.set([0xed, 0xba], 6);

    run(program, [
      { b: 2, c: 0, h: 0, l: 0, f: 0, pc: 3, ram10: 0x00, ram11: 0x00 }, // LD BC,0x0200
      { b: 2, c: 0, h: 0, l: 0x11, f: 0, pc: 6, ram10: 0x00, ram11: 0x00 }, // LD HL,0x0011
      { b: 1, c: 0, h: 0, l: 0x10, f: F_B_NONZERO, pc: 6, ram10: 0x00, ram11: 0xab }, // INDR pass 1 — repeats
      { b: 0, c: 0, h: 0, l: 0x0f, f: F_B_ZERO, pc: 8, ram10: 0xab, ram11: 0xab }, // INDR pass 2 — falls through
    ]);
  });
});
