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
 * `CPIR`/`CPDR` — see "x=10, z=1: CPI/CPD/CPIR/CPDR" in ARCHITECTURE.md.
 * The comparison, the flags, and the pointer direction are already
 * `CPI`/`CPD`'s own machinery (`z80cpu-cpi.test.ts` / `z80cpu-cpd.test.ts`);
 * the one thing genuinely new here is the repeat condition itself, and it
 * is genuinely different from `LDIR`/`LDDR`'s own: real Z80 stops
 * repeating the moment *either* `BC` reaches `0` *or* a match is found —
 * not `BC` alone. `BC` seeded to `2` with the match on the *second* byte
 * exercises the "still more to do, and not found yet" repeat path once,
 * then the "found it" stop; a second scenario below (`BC` exhausted with
 * neither byte matching) proves the *other* way to stop — `BC` hitting
 * `0` alone, with a match never found at all.
 */
describe('buildZ80Cpu — x=10, z=1: CPIR/CPDR (repeat mechanism)', () => {
  const ADDR_BITS = 7;

  interface Snapshot {
    a: number;
    b: number;
    c: number;
    h: number;
    l: number;
    f: number;
    pc: number;
  }
  // Same F bit layout z80cpu-cpi.test.ts uses (LSB first: C,N,P/V,X,H,Y,Z,S).
  const F_REPEAT = 0b00000110; // S=0,Z=0,H=0,P/V=1,N=1 — no match, BC still nonzero: repeats
  const F_MATCH_BC_ZERO = 0b01000010; // S=0,Z=1,H=0,P/V=0,N=1 — match found, BC also 0: stops either way
  const F_NOMATCH_BC_ZERO = 0b00000010; // S=0,Z=0,H=0,P/V=0,N=1 — BC exhausted, never matched: stops on BC alone

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
      a: readReg(cpu.a),
      b: readReg(cpu.rB.q),
      c: readReg(cpu.rC.q),
      h: readReg(cpu.rH.q),
      l: readReg(cpu.rL.q),
      f: readReg(cpu.f),
      pc: readReg(cpu.pc),
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

  it('CPIR walks HL upward and lands PC back on its own opcode until a match is found', () => {
    /**
     * 0: 0x3E,0x77       LD A,0x77   A<-0x77
     * 2: 0x01,0x02,0x00  LD BC,0x0002 BC<-2
     * 5: 0x21,0x50,0x00  LD HL,0x0050 HL<-0x50
     * 8: 0xED,0xB1       CPIR        A-RAM[0x50] (0x11, no match); HL<-0x51,BC<-1,PV<-1; PC<-8 (repeats)
     * 8: 0xED,0xB1       CPIR (again) A-RAM[0x51] (0x77, matches); HL<-0x52,BC<-0,PV<-0; PC<-10 (stops — found)
     */
    const program = new Uint8Array(128);
    program.set([0x3e, 0x77], 0);
    program.set([0x01, 0x02, 0x00], 2);
    program.set([0x21, 0x50, 0x00], 5);
    program.set([0xed, 0xb1], 8);
    program.set([0x11], 0x50);
    program.set([0x77], 0x51);

    run(program, [
      { a: 0x77, b: 0, c: 0, h: 0, l: 0, f: 0, pc: 2 }, // LD A,0x77
      { a: 0x77, b: 0, c: 2, h: 0, l: 0, f: 0, pc: 5 }, // LD BC,0x0002
      { a: 0x77, b: 0, c: 2, h: 0, l: 0x50, f: 0, pc: 8 }, // LD HL,0x0050
      { a: 0x77, b: 0, c: 1, h: 0, l: 0x51, f: F_REPEAT, pc: 8 }, // CPIR pass 1 — no match, repeats
      { a: 0x77, b: 0, c: 0, h: 0, l: 0x52, f: F_MATCH_BC_ZERO, pc: 10 }, // CPIR pass 2 — found, stops
    ]);
  });

  it('CPIR stops on BC reaching 0 alone, when neither byte ever matches', () => {
    const program = new Uint8Array(128);
    program.set([0x3e, 0x77], 0);
    program.set([0x01, 0x02, 0x00], 2);
    program.set([0x21, 0x50, 0x00], 5);
    program.set([0xed, 0xb1], 8);
    program.set([0x11], 0x50);
    program.set([0x22], 0x51);

    run(program, [
      { a: 0x77, b: 0, c: 0, h: 0, l: 0, f: 0, pc: 2 }, // LD A,0x77
      { a: 0x77, b: 0, c: 2, h: 0, l: 0, f: 0, pc: 5 }, // LD BC,0x0002
      { a: 0x77, b: 0, c: 2, h: 0, l: 0x50, f: 0, pc: 8 }, // LD HL,0x0050
      { a: 0x77, b: 0, c: 1, h: 0, l: 0x51, f: F_REPEAT, pc: 8 }, // CPIR pass 1 — no match, repeats
      { a: 0x77, b: 0, c: 0, h: 0, l: 0x52, f: F_NOMATCH_BC_ZERO, pc: 10 }, // CPIR pass 2 — BC=0, stops unmatched
    ]);
  });

  it('CPDR walks HL downward and lands PC back on its own opcode until a match is found', () => {
    /**
     * 0: 0x3E,0x77       LD A,0x77   A<-0x77
     * 2: 0x01,0x02,0x00  LD BC,0x0002 BC<-2
     * 5: 0x21,0x51,0x00  LD HL,0x0051 HL<-0x51
     * 8: 0xED,0xB9       CPDR        A-RAM[0x51] (0x11, no match); HL<-0x50,BC<-1,PV<-1; PC<-8 (repeats)
     * 8: 0xED,0xB9       CPDR (again) A-RAM[0x50] (0x77, matches); HL<-0x4F,BC<-0,PV<-0; PC<-10 (stops — found)
     */
    const program = new Uint8Array(128);
    program.set([0x3e, 0x77], 0);
    program.set([0x01, 0x02, 0x00], 2);
    program.set([0x21, 0x51, 0x00], 5);
    program.set([0xed, 0xb9], 8);
    program.set([0x11], 0x51);
    program.set([0x77], 0x50);

    run(program, [
      { a: 0x77, b: 0, c: 0, h: 0, l: 0, f: 0, pc: 2 }, // LD A,0x77
      { a: 0x77, b: 0, c: 2, h: 0, l: 0, f: 0, pc: 5 }, // LD BC,0x0002
      { a: 0x77, b: 0, c: 2, h: 0, l: 0x51, f: 0, pc: 8 }, // LD HL,0x0051
      { a: 0x77, b: 0, c: 1, h: 0, l: 0x50, f: F_REPEAT, pc: 8 }, // CPDR pass 1 — no match, repeats
      { a: 0x77, b: 0, c: 0, h: 0, l: 0x4f, f: F_MATCH_BC_ZERO, pc: 10 }, // CPDR pass 2 — found, stops
    ]);
  });
});
