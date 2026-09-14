import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu, type Z80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, Pin, SimState } from '../src/sim/types.js';
import { levelAt } from './levelAt.js';

/**
 * Shared harness for every `buildZ80Cpu` test file. The composite is huge
 * (~67k transistors); building it is cheap (~100ms) but the first
 * `flatten()` costs several seconds, and every subsequent `step()` used to
 * dominate wall-clock. Callers should prefer one long program over many
 * short `it()`s that each rebuild+reflatten the same CPU.
 *
 * `tick()` always goes through `flatten()` so Input/Source value flips
 * (clocks, reset, seed WE) land on the cached flat clone — after the first
 * call that path is a WeakMap lookup + a value sync, not a re-clone.
 */
export interface Z80Harness {
  parent: Circuit;
  library: ChipLibrary;
  cpu: Z80Cpu;
  /** Run one relaxation tick (flatten cache + step). */
  tick: () => void;
  /** Rising then falling edge on an Input's `.value`. */
  pulse: (sig: { value: 0 | 1 }) => void;
  /** Drive one full 8-phase ring cycle (phaseClk + dataClk each phase). */
  runInstruction: () => void;
  /** Advance `n` phases from the current position (phaseClk + dataClk each). */
  runPhases: (n: number) => void;
  readReg: (pins: Pin[]) => number;
  readPin: (pin: Pin) => Level;
  levelAt: (pinId: string) => Level;
  /** Live Inputs wired to `cpu.ioPortDataIn`, if `ioPortReply` was given. */
  ioDevice?: { value: 0 | 1 }[];
  /** Live Input wired to maskable INT (`cpu.intDrive`). Default 0. */
  intInput: { value: 0 | 1 };
  phaseClk: { value: 0 | 1 };
  dataClk: { value: 0 | 1 };
}

export function fromBits(bits: Level[]): number {
  return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
}

export function makeZ80Harness(
  program: Uint8Array,
  addrBits = 7,
  seed?: (cpu: Z80Cpu, seedReg: (reg: { we: Pin; d: Pin[] }, value: number, width?: number) => void) => void,
  /** Fixed external I/O-device reply driven onto `ioPortDataIn` for the whole run. */
  ioPortReply?: number,
): Z80Harness {
  const library = new ChipLibrary();
  const parent = new Circuit();
  const cpu = buildZ80Cpu(parent, library, addrBits, program);

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
  for (let i = 0; i < 8; i++) {
    const d = makeInput(parent, i === 0 ? 1 : 0);
    wire(parent, d.pins.out, cpu.fsmD[i]!);
  }

  let ioDevice: { value: 0 | 1 }[] | undefined;
  if (ioPortReply !== undefined) {
    ioDevice = Array.from({ length: 8 }, (_, i) => {
      const bit = ((ioPortReply >> i) & 1) as 0 | 1;
      const input = makeInput(parent, bit);
      wire(parent, input.pins.out, cpu.ioPortDataIn[i]!);
      return input;
    });
  }

  const seedIns: { we: ReturnType<typeof makeInput>; d: ReturnType<typeof makeInput>[] }[] = [];
  const seedReg = (reg: { we: Pin; d: Pin[] }, value: number, width = 8) => {
    const we = makeInput(parent, 1);
    wire(parent, we.pins.out, reg.we);
    const d = Array.from({ length: width }, (_, i) => ((value >> i) & 1) as 0 | 1).map((bit) => makeInput(parent, bit));
    d.forEach((input, i) => wire(parent, input.pins.out, reg.d[i]!));
    seedIns.push({ we, d });
  };

  if (seed) {
    seed(cpu, seedReg);
  } else {
    seedReg(cpu.rB, 0);
    seedReg(cpu.rC, 0);
    seedReg(cpu.rD, 0);
    seedReg(cpu.rE, 0);
    seedReg(cpu.rH, 0);
    seedReg(cpu.rL, 0);
    seedReg(cpu.rIXH, 0);
    seedReg(cpu.rIXL, 0);
    seedReg(cpu.rIYH, 0);
    seedReg(cpu.rIYL, 0);
    seedReg(cpu.sp, 0, addrBits);
    seedReg(cpu.aP, 0);
    seedReg(cpu.fP, 0);
    seedReg(cpu.bP, 0);
    seedReg(cpu.cP, 0);
    seedReg(cpu.dP, 0);
    seedReg(cpu.eP, 0);
    seedReg(cpu.hP, 0);
    seedReg(cpu.lP, 0);
  }

  let state: SimState = initialState();
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

  tick(); // settle with both clocks low
  pulse(phaseClk); // seed FSM into phase 0 (FETCH)
  fsmLoad.value = 0;
  pulse(dataClk); // PC/A reset + register seeds
  resetPulse.value = 0;
  aResetPulse.value = 0;
  for (const s of seedIns) s.we.value = 0;
  pulse(dataClk); // real first fetch: IR <- PROGRAM[0]

  const runPhases = (n: number) => {
    for (let i = 0; i < n; i++) {
      pulse(phaseClk);
      pulse(dataClk);
    }
  };

  return {
    parent,
    library,
    cpu,
    tick,
    pulse,
    runInstruction: () => runPhases(8),
    runPhases,
    readReg: (pins) => fromBits(pins.map((p) => levelAt(state, netMap, p.id))),
    readPin: (pin) => levelAt(state, netMap, pin.id),
    levelAt: (pinId) => levelAt(state, netMap, pinId),
    ioDevice,
    intInput: cpu.intDrive,
    phaseClk,
    dataClk,
  };
}
