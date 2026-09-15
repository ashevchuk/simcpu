import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

describe('buildZ80Cpu — x=11: JP nn (unconditional 16-bit jump)', () => {
  /**
   * A real control-flow test, not just a register check: address 3 holds
   * a deliberate "wrong path" trap (`LD A,0xEE`) that would fire if `JP
   * nn` failed to redirect `PC` at all (falling through to the next
   * instruction the way a no-op jump would) — the jump target (address
   * 16) holds a different, distinct `LD A,0x42`. Only a genuinely correct
   * jump makes `A` end up `0x42`; any of "didn't jump," "jumped to the
   * wrong address," or "read the target bytes in the wrong order" would
   * leave `A` as `0xEE`, `0x00` (reset, never written), or something else
   * entirely, not `0x42`.
   *
   *  0: 0xC3,0x10,0x00  JP 0x0010          PC <- 0x10, A untouched
   *  3: 0x3E,0xEE       LD A,0xEE          (never reached — the trap)
   * 16: 0x3E,0x42       LD A,0x42          A <- 0x42 — proves the jump landed exactly here
   */
  const ADDR_BITS = 5;
  const JUMP_TARGET = 0x10;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(32);
    bytes.set([0xc3, 0x10, 0x00], 0);
    bytes.set([0x3e, 0xee], 3);
    bytes.set([0x3e, 0x42], JUMP_TARGET);
    return bytes;
  })();

  interface Snapshot {
    a: number;
    pc: number;
  }
  const EXPECTED: Snapshot[] = [
    { a: 0x00, pc: 0x10 }, // JP 0x0010 — A untouched, PC redirected
    { a: 0x42, pc: 0x12 }, // LD A,0x42 (at the jump target) — proves control flow actually landed here
  ];

  function fromBits(bits: Level[]): number {
    return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
  }
  function toBits(n: number, width: number): (0 | 1)[] {
    return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
  }

  it('redirects PC to a real 16-bit target instead of falling through to the trap right after it', () => {
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
    // every other buildZ80Cpu test in this file already follows, avoiding
    // a floating external-seed sink on B/C/D/E/H/L/SP.
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
    // this composite is deeper still now (jpTarget's own holding register
    // and its write-back, a third mux layer on PC's own retMux/rstMux
    // chain).
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
      pulse(phaseClk); // -> EXEC1
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC2
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC3
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC4
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC5 (a genuine no-op for this group too — see "x=11: CALL nn")
      pulse(dataClk);
      pulse(phaseClk); // -> EXEC6 (ditto)
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
