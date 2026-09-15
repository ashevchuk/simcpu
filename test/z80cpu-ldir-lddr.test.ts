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
 * `LDIR`/`LDDR` — see "x=10, z=0: LDI/LDD/LDIR/LDDR" in ARCHITECTURE.md.
 * Everything about the byte transfer, the pointer direction, and the flags
 * is already `LDI`/`LDD`'s machinery (`z80cpu-ldi.test.ts` /
 * `z80cpu-ldd.test.ts`); the one thing genuinely new here — and the only
 * thing worth a dedicated test — is the repeat mechanism itself: instead
 * of a real hardware micro-cycle, this project lands `PC` back on its own
 * opcode (`pc<-pc-2`) for as long as `BC` is still nonzero after the
 * decrement, and lets it fall through to the next real opcode the moment
 * `BC` hits 0. `BC` is seeded to 2 so the transfer runs exactly twice: the
 * first `runInstruction()` pass must show `PC` landed back on the `ED`
 * opcode's own address (the repeat firing), and the second must show `PC`
 * advanced two bytes past it (the repeat correctly *not* firing once
 * `BC` reaches 0).
 */
describe('buildZ80Cpu — x=10, z=0: LDIR/LDDR (repeat mechanism)', () => {
  const ADDR_BITS = 7;

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
  const F_PV_SET = 0b00000100;
  const F_PV_CLEAR = 0b00000000;

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
    pulse(dataClk); // real first fetch: IR <- program[0]

    const runInstruction = () => {
      for (let i = 0; i < 10; i++) {
        pulse(phaseClk);
        pulse(dataClk);
      }
    };

    for (const step of expected) {
      runInstruction();
      expect(snapshot()).toEqual(step);
    }
  }

  it('LDIR walks HL/DE upward and lands PC back on its own opcode until BC reaches 0', () => {
    /**
     * 0: 0x01,0x02,0x00  LD BC,0x0002   BC<-2
     * 3: 0x11,0x60,0x00  LD DE,0x0060   DE<-0x60
     * 6: 0x21,0x50,0x00  LD HL,0x0050   HL<-0x50
     * 9: 0xED,0xB0       LDIR           RAM[0x60]<-RAM[0x50] (0x11); HL<-0x51,DE<-0x61,BC<-1,P/V<-1; PC<-9 (repeats)
     * 9: 0xED,0xB0       LDIR (again)   RAM[0x61]<-RAM[0x51] (0x22); HL<-0x52,DE<-0x62,BC<-0,P/V<-0; PC<-11 (falls through)
     */
    const program = new Uint8Array(128);
    program.set([0x01, 0x02, 0x00], 0);
    program.set([0x11, 0x60, 0x00], 3);
    program.set([0x21, 0x50, 0x00], 6);
    program.set([0xed, 0xb0], 9);
    program.set([0x11], 0x50);
    program.set([0x22], 0x51);

    run(program, [
      { b: 0, c: 2, d: 0, e: 0, h: 0, l: 0, f: 0, pc: 3, ram60: 0x00, ram61: 0x00 }, // LD BC,0x0002
      { b: 0, c: 2, d: 0, e: 0x60, h: 0, l: 0, f: 0, pc: 6, ram60: 0x00, ram61: 0x00 }, // LD DE,0x0060
      { b: 0, c: 2, d: 0, e: 0x60, h: 0, l: 0x50, f: 0, pc: 9, ram60: 0x00, ram61: 0x00 }, // LD HL,0x0050
      { b: 0, c: 1, d: 0, e: 0x61, h: 0, l: 0x51, f: F_PV_SET, pc: 9, ram60: 0x11, ram61: 0x00 }, // LDIR pass 1 — repeats
      { b: 0, c: 0, d: 0, e: 0x62, h: 0, l: 0x52, f: F_PV_CLEAR, pc: 11, ram60: 0x11, ram61: 0x22 }, // LDIR pass 2 — falls through
    ]);
  });

  it('LDDR walks HL/DE downward and lands PC back on its own opcode until BC reaches 0', () => {
    /**
     * 0: 0x01,0x02,0x00  LD BC,0x0002   BC<-2
     * 3: 0x11,0x61,0x00  LD DE,0x0061   DE<-0x61
     * 6: 0x21,0x51,0x00  LD HL,0x0051   HL<-0x51
     * 9: 0xED,0xB8       LDDR           RAM[0x61]<-RAM[0x51] (0x11); HL<-0x50,DE<-0x60,BC<-1,P/V<-1; PC<-9 (repeats)
     * 9: 0xED,0xB8       LDDR (again)   RAM[0x60]<-RAM[0x50] (0x22); HL<-0x4F,DE<-0x5F,BC<-0,P/V<-0; PC<-11 (falls through)
     */
    const program = new Uint8Array(128);
    program.set([0x01, 0x02, 0x00], 0);
    program.set([0x11, 0x61, 0x00], 3);
    program.set([0x21, 0x51, 0x00], 6);
    program.set([0xed, 0xb8], 9);
    program.set([0x11], 0x51);
    program.set([0x22], 0x50);

    run(program, [
      { b: 0, c: 2, d: 0, e: 0, h: 0, l: 0, f: 0, pc: 3, ram60: 0x00, ram61: 0x00 }, // LD BC,0x0002
      { b: 0, c: 2, d: 0, e: 0x61, h: 0, l: 0, f: 0, pc: 6, ram60: 0x00, ram61: 0x00 }, // LD DE,0x0061
      { b: 0, c: 2, d: 0, e: 0x61, h: 0, l: 0x51, f: 0, pc: 9, ram60: 0x00, ram61: 0x00 }, // LD HL,0x0051
      { b: 0, c: 1, d: 0, e: 0x60, h: 0, l: 0x50, f: F_PV_SET, pc: 9, ram60: 0x00, ram61: 0x11 }, // LDDR pass 1 — repeats
      { b: 0, c: 0, d: 0, e: 0x5f, h: 0, l: 0x4f, f: F_PV_CLEAR, pc: 11, ram60: 0x22, ram61: 0x11 }, // LDDR pass 2 — falls through
    ]);
  });
});
