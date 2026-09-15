import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/sim/Circuit.js';
import { makeInput, makeSource, wire } from '../src/sim/library.js';
import { buildDFlipFlop, buildDLatch, buildRegisterBit } from '../src/sim/sequential.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, SimState } from '../src/sim/types.js';

/** Advance the solver `n` times, carrying state forward (needed for feedback-held nets to converge after an input change). */
function tick(circuit: Circuit, netMap: NetMap, state: SimState, n = 10): SimState {
  for (let i = 0; i < n; i++) state = step(circuit, netMap, state);
  return state;
}

function levelAt(state: SimState, netMap: NetMap, pinId: string): Level {
  const net = netMap.netOf.get(pinId);
  if (!net) throw new Error(`unknown pin ${pinId}`);
  return state.levelOf.get(net) ?? 'Z';
}

describe('D-latch — transparent while EN=1, holds while EN=0', () => {
  it('tracks D when enabled and freezes when disabled', () => {
    const circuit = new Circuit();
    const vcc = makeSource(circuit, 1).pins.out;
    const gnd = makeSource(circuit, 0).pins.out;
    const latch = buildDLatch(circuit);
    const d = makeInput(circuit, 0);
    const en = makeInput(circuit, 0);
    wire(circuit, d.pins.out, latch.d);
    wire(circuit, en.pins.out, latch.en);

    const netMap = circuit.computeNets();
    let state = initialState();

    en.value = 1;
    d.value = 1;
    state = tick(circuit, netMap, state);
    expect(levelAt(state, netMap, latch.q.id)).toBe(1); // transparent: tracks D=1

    d.value = 0;
    state = tick(circuit, netMap, state);
    expect(levelAt(state, netMap, latch.q.id)).toBe(0); // still transparent: tracks D=0

    en.value = 0;
    d.value = 1;
    state = tick(circuit, netMap, state);
    expect(levelAt(state, netMap, latch.q.id)).toBe(0); // disabled: ignores the new D, holds 0

    d.value = 0;
    state = tick(circuit, netMap, state);
    expect(levelAt(state, netMap, latch.q.id)).toBe(0); // still holding

    en.value = 1;
    state = tick(circuit, netMap, state);
    expect(levelAt(state, netMap, latch.q.id)).toBe(0); // re-enabled: tracks D=0 again (unchanged, but transparent now)
  });
});

describe('D flip-flop — captures D only on the CLK 0->1 edge', () => {
  it('ignores D changes while CLK is steady, captures fresh D on the next rising edge', () => {
    const circuit = new Circuit();
    const vcc = makeSource(circuit, 1).pins.out;
    const gnd = makeSource(circuit, 0).pins.out;
    const dff = buildDFlipFlop(circuit);
    const d = makeInput(circuit, 0);
    const clk = makeInput(circuit, 0);
    wire(circuit, d.pins.out, dff.d);
    wire(circuit, clk.pins.out, dff.clk);

    const netMap = circuit.computeNets();
    let state = initialState();

    // CLK=0, D=1: master tracks D, slave (opaque) not asserted about yet.
    d.value = 1;
    state = tick(circuit, netMap, state);

    // Rising edge with D=1 -> Q captures 1.
    clk.value = 1;
    state = tick(circuit, netMap, state);
    expect(levelAt(state, netMap, dff.q.id)).toBe(1);

    // D changes while CLK stays high: master is closed, must not leak through.
    d.value = 0;
    state = tick(circuit, netMap, state);
    expect(levelAt(state, netMap, dff.q.id)).toBe(1);

    // Falling edge: slave closes holding its last value, regardless of D.
    clk.value = 0;
    state = tick(circuit, netMap, state);
    expect(levelAt(state, netMap, dff.q.id)).toBe(1);

    // D settles to 0 while CLK is low (master free to track it) — no visible change yet.
    state = tick(circuit, netMap, state);
    expect(levelAt(state, netMap, dff.q.id)).toBe(1);

    // Second rising edge, this time with D=0 -> Q must actually flip to 0,
    // proving this is real edge capture and not a coincidental stale hold.
    clk.value = 1;
    state = tick(circuit, netMap, state);
    expect(levelAt(state, netMap, dff.q.id)).toBe(0);
  });
});

describe('register bit — writes on WE=1, re-latches its own Q on WE=0', () => {
  it('is a write-gated D flip-flop, not a clock-gated one', () => {
    const circuit = new Circuit();
    makeSource(circuit, 1); // rail driver
    makeSource(circuit, 0);
    const bit = buildRegisterBit(circuit);
    const d = makeInput(circuit, 0);
    const we = makeInput(circuit, 0);
    const clk = makeInput(circuit, 0);
    wire(circuit, d.pins.out, bit.d);
    wire(circuit, we.pins.out, bit.we);
    wire(circuit, clk.pins.out, bit.clk);

    const netMap = circuit.computeNets();
    let state = initialState();

    // WE=1, D=1, clock it in.
    we.value = 1;
    d.value = 1;
    state = tick(circuit, netMap, state);
    clk.value = 1;
    state = tick(circuit, netMap, state);
    expect(levelAt(state, netMap, bit.q.id)).toBe(1);
    clk.value = 0;
    state = tick(circuit, netMap, state);

    // WE=0: further clock edges must NOT capture the new D, even though
    // the flip-flop is still being clocked normally (this is what
    // distinguishes write-gating from clock-gating).
    we.value = 0;
    d.value = 0;
    state = tick(circuit, netMap, state);
    clk.value = 1;
    state = tick(circuit, netMap, state);
    expect(levelAt(state, netMap, bit.q.id)).toBe(1); // still 1, the write was disabled
    clk.value = 0;
    state = tick(circuit, netMap, state);
    clk.value = 1;
    state = tick(circuit, netMap, state);
    expect(levelAt(state, netMap, bit.q.id)).toBe(1); // holds across repeated edges while WE=0

    // WE=1 again: the next edge captures the (now different) D.
    clk.value = 0;
    we.value = 1;
    state = tick(circuit, netMap, state);
    clk.value = 1;
    state = tick(circuit, netMap, state);
    expect(levelAt(state, netMap, bit.q.id)).toBe(0);
  });
});
