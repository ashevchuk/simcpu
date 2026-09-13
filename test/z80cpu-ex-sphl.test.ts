import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=11, z=3, y=4: EX (SP),HL', () => {
  /**
   * The one member of this file's "swap on one edge" family that swaps a
   * register pair with *RAM* instead of another register — a real 4-phase
   * read-modify-write, not a register-to-register mux. `RAM[0x60]`/
   * `RAM[0x61]` (well clear of the program bytes themselves) are seeded to
   * `0x11`/`0x22`, `HL` to `0xBBAA` — four genuinely distinct bytes, so a
   * mixed-up byte order (low/high swapped) or a half-finished swap (only
   * `HL` updates, or only RAM does) shows up as a wrong value in a specific
   * place, not a coincidental match. `RAM`'s own bytes are read directly
   * (`cpu.ram.bytes`), the same technique the `INC (HL)`/`DEC (HL)` test
   * uses, to prove the write itself landed independently of whether the
   * CPU's own read-back is also correct. A second `EX (SP),HL` right after
   * is the real proof, same as every other swap in this file: it must land
   * every one of `H`/`L`/`RAM[0x60]`/`RAM[0x61]` back on its starting
   * value, not leave the second swap a no-op.
   *
   * 0: 0x21,0xAA,0xBB   LD HL,0xBBAA   HL<-0xBBAA (H=0xBB, L=0xAA)
   * 3: 0x31,0x60,0x00   LD SP,0x0060   SP<-0x60
   * 6: 0xE3             EX (SP),HL     L<-old RAM[0x60] (0x11), H<-old RAM[0x61] (0x22); RAM[0x60]<-old L (0xAA), RAM[0x61]<-old H (0xBB)
   * 7: 0xE3             EX (SP),HL     back to the start
   */
  const ADDR_BITS = 7;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0x21, 0xaa, 0xbb], 0);
    bytes.set([0x31, 0x60, 0x00], 3);
    bytes.set([0xe3], 6);
    bytes.set([0xe3], 7);
    bytes.set([0x11], 0x60);
    bytes.set([0x22], 0x61);
    return bytes;
  })();

  interface Snapshot {
    h: number;
    l: number;
    sp: number;
    pc: number;
    ram60: number;
    ram61: number;
  }
  const EXPECTED: Snapshot[] = [
    { h: 0xbb, l: 0xaa, sp: 0, pc: 3, ram60: 0x11, ram61: 0x22 }, // LD HL,0xBBAA
    { h: 0xbb, l: 0xaa, sp: 0x60, pc: 6, ram60: 0x11, ram61: 0x22 }, // LD SP,0x0060
    { h: 0x22, l: 0x11, sp: 0x60, pc: 7, ram60: 0xaa, ram61: 0xbb }, // EX (SP),HL
    { h: 0xbb, l: 0xaa, sp: 0x60, pc: 8, ram60: 0x11, ram61: 0x22 }, // EX (SP),HL again — back to the start
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('swaps HL with the word at [SP] through real RAM, and reverses cleanly on a second EX (SP),HL', () => {
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
      pulse(phaseClk); // -> INCREMENT
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC1 (LD HL,nn/LD SP,nn read their own low byte here; EX (SP),HL reads [SP] here)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC2 (EX (SP),HL reads [SP+1] here)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC3 (EX (SP),HL writes [SP] here)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC4 (EX (SP),HL writes [SP+1] here)
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
