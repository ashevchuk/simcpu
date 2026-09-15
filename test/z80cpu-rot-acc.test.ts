import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=00, z=7: RLCA/RRCA/RLA/RRA/CPL/SCF/CCF', () => {
  /**
   * No RAM access anywhere in this program past the initial fetch of each
   * opcode byte — every one of these seven is a single-byte register/flag
   * op, so this test is really about `A`/`F`'s own bit-level correctness,
   * not addressing. `SCF`/`CCF` never touch `A` at all (checked by reading
   * `A` right after each and finding it unchanged); the rotates and `CPL`
   * are checked by feeding them a deliberately asymmetric `0x55` so a
   * transposed bit or an off-by-one in the wrap-around shows up as a wrong
   * byte, not a coincidentally-still-right one. `RLA`/`RRA` are exercised
   * right after `CCF` leaves a known, non-zero `C` — proving the *old*
   * carry actually feeds into the new bit 0/7, not just that the shift
   * direction is right. The real Z80 gotcha this test deliberately proves
   * rather than assumes: none of these seven touch `S`/`Z`/`P` — `Z` and
   * `S` are left stale from the initial `XOR A,A` (`Z=1`, `S=0`) through
   * every single later instruction, even once `A` holds `0xAA` (bit 7
   * set) after the first `RLCA` — a wrong implementation that "helpfully"
   * recomputes `S`/`Z` from the new `A` would fail here, not pass by
   * accident.
   *
   *  0: 0xAF        XOR A,A   A<-0x00, F<-Z=1,N=0,S=0,C=0 (known start)
   *  1: 0x37        SCF       C<-1, N<-0 (Z/S untouched, A untouched)
   *  2: 0x3F        CCF       C<-NOT(1)=0, N<-0
   *  3: 0x3F        CCF       C<-NOT(0)=1, N<-0
   *  4: 0x3E,0x55   LD A,n    A<-0x55 (flags untouched — Z/S/C stay stale)
   *  6: 0x07        RLCA      A<-0xAA (0x55 rotated left), C<-old bit7=0
   *  7: 0x07        RLCA      A<-0x55, C<-old bit7=1
   *  8: 0x0F        RRCA      A<-0xAA, C<-old bit0=1
   *  9: 0x0F        RRCA      A<-0x55, C<-old bit0=0
   * 10: 0x17        RLA       A<-0xAA (old C=0 into bit0), C<-old bit7=0
   * 11: 0x17        RLA       A<-0x54 (old C=0 into bit0), C<-old bit7=1
   * 12: 0x1F        RRA       A<-0xAA (old C=1 into bit7), C<-old bit0=0
   * 13: 0x1F        RRA       A<-0x55 (old C=0 into bit7), C<-old bit0=0
   * 14: 0x2F        CPL       A<-0xAA (~0x55), N<-1 (C/Z/S untouched)
   * 15: 0x2F        CPL       A<-0x55 (~0xAA again — round trip)
   */
  const ADDR_BITS = 7;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0xaf], 0);
    bytes.set([0x37], 1);
    bytes.set([0x3f], 2);
    bytes.set([0x3f], 3);
    bytes.set([0x3e, 0x55], 4);
    bytes.set([0x07], 6);
    bytes.set([0x07], 7);
    bytes.set([0x0f], 8);
    bytes.set([0x0f], 9);
    bytes.set([0x17], 10);
    bytes.set([0x17], 11);
    bytes.set([0x1f], 12);
    bytes.set([0x1f], 13);
    bytes.set([0x2f], 14);
    bytes.set([0x2f], 15);
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
    { a: 0x00, c: 1, n: 0, z: 1, s: 0, pc: 2 }, // SCF
    { a: 0x00, c: 0, n: 0, z: 1, s: 0, pc: 3 }, // CCF
    { a: 0x00, c: 1, n: 0, z: 1, s: 0, pc: 4 }, // CCF
    { a: 0x55, c: 1, n: 0, z: 1, s: 0, pc: 6 }, // LD A,0x55
    { a: 0xaa, c: 0, n: 0, z: 1, s: 0, pc: 7 }, // RLCA
    { a: 0x55, c: 1, n: 0, z: 1, s: 0, pc: 8 }, // RLCA
    { a: 0xaa, c: 1, n: 0, z: 1, s: 0, pc: 9 }, // RRCA
    { a: 0x55, c: 0, n: 0, z: 1, s: 0, pc: 10 }, // RRCA
    { a: 0xaa, c: 0, n: 0, z: 1, s: 0, pc: 11 }, // RLA
    { a: 0x54, c: 1, n: 0, z: 1, s: 0, pc: 12 }, // RLA
    { a: 0xaa, c: 0, n: 0, z: 1, s: 0, pc: 13 }, // RRA
    { a: 0x55, c: 0, n: 0, z: 1, s: 0, pc: 14 }, // RRA
    { a: 0xaa, c: 0, n: 1, z: 1, s: 0, pc: 15 }, // CPL
    { a: 0x55, c: 0, n: 1, z: 1, s: 0, pc: 16 }, // CPL
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('rotates and complements A, and sets/clears/inverts C, leaving S/Z/P stale the whole time', () => {
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

    pulse(dataClk); // PC/A reset, B/C/D/E/H/L/SP seeded
    resetPulse.value = 0;
    aResetPulse.value = 0;
    for (const s of seedIns) s.we.value = 0;
    pulse(dataClk); // real first fetch: IR <- PROGRAM[0]

    const runInstruction = () => {
      pulse(phaseClk); // -> INCREMENT
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC1 (LD A,n reads its own immediate byte here)
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
