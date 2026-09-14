import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';

const ADDR_BITS = 7;
const PROGRAM = new Uint8Array(128);
PROGRAM.set([0x3e, 0x3a, 0x21, 0x10, 0x00, 0xed, 0x67], 0);
PROGRAM[0x10] = 0x12;

const t0 = performance.now();
const library = new ChipLibrary();
const parent = new Circuit();
const cpu = buildZ80Cpu(parent, library, ADDR_BITS, PROGRAM);
const tBuild = performance.now() - t0;

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

const t1 = performance.now();
let flat = flatten(parent, library);
let netMap = flat.computeNets();
const tFlat1 = performance.now() - t1;

const t2 = performance.now();
flat = flatten(parent, library);
netMap = flat.computeNets();
const tFlat2 = performance.now() - t2;

let nTrans = 0;
let nComp = 0;
const nNets = netMap.pinsOf.size;
for (const c of flat.components.values()) {
  nComp++;
  if (c.kind === 'transistor') nTrans++;
}

let state = initialState();
const stepTimes: number[] = [];
const iterCounts: number[] = [];
for (let i = 0; i < 16; i++) {
  const ts = performance.now();
  flat = flatten(parent, library);
  netMap = flat.computeNets();
  state = step(flat, netMap, state, 300);
  stepTimes.push(performance.now() - ts);
  iterCounts.push(state.iterations);
  phaseClk.value = (phaseClk.value ^ 1) as 0 | 1;
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log(
  JSON.stringify(
    {
      tBuildMs: Math.round(tBuild),
      tFlat1Ms: Math.round(tFlat1),
      tFlat2Ms: Math.round(tFlat2),
      nComp,
      nTrans,
      nNets,
      stepAvgMs: Math.round(avg(stepTimes)),
      stepMinMs: Math.round(Math.min(...stepTimes)),
      stepMaxMs: Math.round(Math.max(...stepTimes)),
      iterAvg: Math.round(avg(iterCounts)),
      iterMin: Math.min(...iterCounts),
      iterMax: Math.max(...iterCounts),
      settled: state.settled,
    },
    null,
    2,
  ),
);
