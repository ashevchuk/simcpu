import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=11, z=6: ALU op A,n', () => {
  /**
   * The immediate-operand twin of `x=10`'s own ALU-on-register group,
   * proven here to reuse that exact machinery rather than needing its own:
   * all eight operations (`ADD`/`ADC`/`SUB`/`SBC`/`AND`/`XOR`/`OR`/`CP
   * A,n`) run in sequence, each reading straight off the byte right after
   * its own opcode, `PC` advancing by 2 each time (proving the immediate
   * byte is genuinely consumed, not skipped or double-read). `CP`'s own
   * `A` is checked explicitly unchanged — real Z80 `CP` only sets flags.
   *
   *  0: 0xAF        XOR A,A       A<-0x00, F<-Z=1,N=0,C=0 (known start)
   *  1: 0xC6,0x0F   ADD A,0x0F    A<-0x0F, C<-0
   *  3: 0xCE,0x01   ADC A,0x01    A<-0x10 (old C=0), C<-0
   *  5: 0xD6,0x10   SUB 0x10      A<-0x00, C<-0, Z<-1, N<-1
   *  7: 0xDE,0x00   SBC A,0x00    A<-0x00 (old C=0), C<-0, Z<-1, N<-1
   *  9: 0xE6,0xFF   AND 0xFF      A<-0x00, C<-0 (AND always clears C), Z<-1
   * 11: 0xF6,0x0F   OR 0x0F       A<-0x0F, Z<-0
   * 13: 0xEE,0x0F   XOR 0x0F      A<-0x00, Z<-1
   * 15: 0xFE,0x01   CP 0x01       A unchanged (0x00) — 0x00-0x01 borrows: C<-1, Z<-0, N<-1, S<-1
   */
  const ADDR_BITS = 7;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0xaf], 0);
    bytes.set([0xc6, 0x0f], 1);
    bytes.set([0xce, 0x01], 3);
    bytes.set([0xd6, 0x10], 5);
    bytes.set([0xde, 0x00], 7);
    bytes.set([0xe6, 0xff], 9);
    bytes.set([0xf6, 0x0f], 11);
    bytes.set([0xee, 0x0f], 13);
    bytes.set([0xfe, 0x01], 15);
    return bytes;
  })();

  interface Snapshot {
    a: number;
    c: number;
    n: number;
    z: number;
    s: number;
    pc: number;
  }
  const EXPECTED: Snapshot[] = [
    { a: 0x00, c: 0, n: 0, z: 1, s: 0, pc: 1 }, // XOR A,A
    { a: 0x0f, c: 0, n: 0, z: 0, s: 0, pc: 3 }, // ADD A,0x0F
    { a: 0x10, c: 0, n: 0, z: 0, s: 0, pc: 5 }, // ADC A,0x01
    { a: 0x00, c: 0, n: 1, z: 1, s: 0, pc: 7 }, // SUB 0x10
    { a: 0x00, c: 0, n: 1, z: 1, s: 0, pc: 9 }, // SBC A,0x00
    { a: 0x00, c: 0, n: 0, z: 1, s: 0, pc: 11 }, // AND 0xFF
    { a: 0x0f, c: 0, n: 0, z: 0, s: 0, pc: 13 }, // OR 0x0F
    { a: 0x00, c: 0, n: 0, z: 1, s: 0, pc: 15 }, // XOR 0x0F
    { a: 0x00, c: 1, n: 1, z: 0, s: 1, pc: 17 }, // CP 0x01 — A untouched, flags from the discarded subtraction
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('runs all eight immediate ALU ops in sequence, each consuming its own operand byte', () => {
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
      a: readReg(cpu.a),
      c: readReg([cpu.f[0]!]),
      n: readReg([cpu.f[1]!]),
      z: readReg([cpu.f[6]!]),
      s: readReg([cpu.f[7]!]),
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
      pulse(phaseClk); // -> EXEC1 (reads the immediate byte here)
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC2 (commits A/F, and advances PC past the immediate byte)
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
