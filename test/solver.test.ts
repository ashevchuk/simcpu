import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/sim/Circuit.js';
import {
  buildAnd,
  buildDecoder,
  buildFullAdder,
  buildHalfAdder,
  buildMux2,
  buildMux4,
  buildNand,
  buildNor,
  buildNot,
  buildOr,
  buildSrLatch,
  buildTriStateBuffer,
  buildXor,
  makeInput,
  makeLabel,
  makeLed,
  makeSource,
  wire,
} from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level } from '../src/sim/types.js';

/** Run the relaxation solver until it reports a settled fixpoint (or throw). */
function settle(circuit: Circuit) {
  const netMap = circuit.computeNets();
  let state = initialState();
  for (let i = 0; i < 8 && (i === 0 || !state.settled); i++) {
    state = step(circuit, netMap, state);
  }
  if (!state.settled) throw new Error('circuit did not settle');
  return { netMap, state };
}

function levelAt(state: ReturnType<typeof settle>['state'], netMap: ReturnType<typeof settle>['netMap'], pinId: string): Level {
  const net = netMap.netOf.get(pinId);
  if (!net) throw new Error(`unknown pin ${pinId}`);
  return state.levelOf.get(net) ?? 'Z';
}

describe('NOT gate (2 transistors)', () => {
  it.each([
    [0, 1],
    [1, 0],
  ] as const)('in=%i -> out=%i', (inVal, outVal) => {
    const circuit = new Circuit();
    const vcc = makeSource(circuit, 1).pins.out;
    const gnd = makeSource(circuit, 0).pins.out;
    const notGate = buildNot(circuit);
    const input = makeInput(circuit, inVal);
    wire(circuit, input.pins.out, notGate.in);

    const { netMap, state } = settle(circuit);
    expect(levelAt(state, netMap, notGate.out.id)).toBe(outVal);
  });
});

describe('NAND gate (4 transistors)', () => {
  it.each([
    [0, 0, 1],
    [0, 1, 1],
    [1, 0, 1],
    [1, 1, 0],
  ] as const)('a=%i b=%i -> out=%i', (a, b, out) => {
    const circuit = new Circuit();
    const vcc = makeSource(circuit, 1).pins.out;
    const gnd = makeSource(circuit, 0).pins.out;
    const nand = buildNand(circuit);
    const inA = makeInput(circuit, a);
    const inB = makeInput(circuit, b);
    wire(circuit, inA.pins.out, nand.a);
    wire(circuit, inB.pins.out, nand.b);

    const { netMap, state } = settle(circuit);
    expect(levelAt(state, netMap, nand.out.id)).toBe(out);
  });
});

describe('AND gate (NAND + NOT, 6 transistors)', () => {
  it.each([
    [0, 0, 0],
    [0, 1, 0],
    [1, 0, 0],
    [1, 1, 1],
  ] as const)('a=%i b=%i -> out=%i', (a, b, out) => {
    const circuit = new Circuit();
    const vcc = makeSource(circuit, 1).pins.out;
    const gnd = makeSource(circuit, 0).pins.out;
    const and = buildAnd(circuit);
    const inA = makeInput(circuit, a);
    const inB = makeInput(circuit, b);
    wire(circuit, inA.pins.out, and.a);
    wire(circuit, inB.pins.out, and.b);

    const { netMap, state } = settle(circuit);
    expect(levelAt(state, netMap, and.out.id)).toBe(out);
  });
});

describe('NOR gate (4 transistors, dual of NAND)', () => {
  it.each([
    [0, 0, 1],
    [0, 1, 0],
    [1, 0, 0],
    [1, 1, 0],
  ] as const)('a=%i b=%i -> out=%i', (a, b, out) => {
    const circuit = new Circuit();
    const vcc = makeSource(circuit, 1).pins.out;
    const gnd = makeSource(circuit, 0).pins.out;
    const nor = buildNor(circuit);
    const inA = makeInput(circuit, a);
    const inB = makeInput(circuit, b);
    wire(circuit, inA.pins.out, nor.a);
    wire(circuit, inB.pins.out, nor.b);

    const { netMap, state } = settle(circuit);
    expect(levelAt(state, netMap, nor.out.id)).toBe(out);
  });
});

describe('OR gate (NOR + NOT, 6 transistors)', () => {
  it.each([
    [0, 0, 0],
    [0, 1, 1],
    [1, 0, 1],
    [1, 1, 1],
  ] as const)('a=%i b=%i -> out=%i', (a, b, out) => {
    const circuit = new Circuit();
    const vcc = makeSource(circuit, 1).pins.out;
    const gnd = makeSource(circuit, 0).pins.out;
    const or = buildOr(circuit);
    const inA = makeInput(circuit, a);
    const inB = makeInput(circuit, b);
    wire(circuit, inA.pins.out, or.a);
    wire(circuit, inB.pins.out, or.b);

    const { netMap, state } = settle(circuit);
    expect(levelAt(state, netMap, or.out.id)).toBe(out);
  });
});

describe('XOR gate (4-NAND composition, 16 transistors)', () => {
  it.each([
    [0, 0, 0],
    [0, 1, 1],
    [1, 0, 1],
    [1, 1, 0],
  ] as const)('a=%i b=%i -> out=%i', (a, b, out) => {
    const circuit = new Circuit();
    const vcc = makeSource(circuit, 1).pins.out;
    const gnd = makeSource(circuit, 0).pins.out;
    const xor = buildXor(circuit);
    const inA = makeInput(circuit, a);
    const inB = makeInput(circuit, b);
    wire(circuit, inA.pins.out, xor.a);
    wire(circuit, inB.pins.out, xor.b);

    const { netMap, state } = settle(circuit);
    expect(levelAt(state, netMap, xor.out.id)).toBe(out);
  });
});

describe('2:1 mux (NOT/AND/OR composition)', () => {
  it.each([
    [0, 0, 1, 0],
    [1, 0, 1, 1],
    [0, 1, 0, 1],
    [1, 1, 0, 0],
  ] as const)('sel=%i, in0=%i, in1=%i -> out=%i', (sel, in0Val, in1Val, out) => {
    const circuit = new Circuit();
    const vcc = makeSource(circuit, 1).pins.out;
    const gnd = makeSource(circuit, 0).pins.out;
    const mux = buildMux2(circuit);
    const inSel = makeInput(circuit, sel);
    const in0 = makeInput(circuit, in0Val);
    const in1 = makeInput(circuit, in1Val);
    wire(circuit, inSel.pins.out, mux.sel);
    wire(circuit, in0.pins.out, mux.in0);
    wire(circuit, in1.pins.out, mux.in1);

    const { netMap, state } = settle(circuit);
    expect(levelAt(state, netMap, mux.out.id)).toBe(out);
  });
});

describe('4:1 mux (tree of three 2:1 muxes)', () => {
  it.each([
    [0, 0, 0],
    [1, 0, 1],
    [0, 1, 2],
    [1, 1, 3],
  ] as const)('sel1=%i sel0=%i -> routes in%i', (sel0, sel1, expectedIndex) => {
    const circuit = new Circuit();
    const vcc = makeSource(circuit, 1).pins.out;
    const gnd = makeSource(circuit, 0).pins.out;
    const mux = buildMux4(circuit);
    const s0 = makeInput(circuit, sel0);
    const s1 = makeInput(circuit, sel1);
    const ins = [makeInput(circuit, 0), makeInput(circuit, 0), makeInput(circuit, 0), makeInput(circuit, 0)];
    ins[expectedIndex]!.value = 1; // only the selected input is driven high
    wire(circuit, s0.pins.out, mux.sel0);
    wire(circuit, s1.pins.out, mux.sel1);
    wire(circuit, ins[0]!.pins.out, mux.in0);
    wire(circuit, ins[1]!.pins.out, mux.in1);
    wire(circuit, ins[2]!.pins.out, mux.in2);
    wire(circuit, ins[3]!.pins.out, mux.in3);

    const { netMap, state } = settle(circuit);
    expect(levelAt(state, netMap, mux.out.id)).toBe(1);
  });
});

describe('half adder (XOR + AND, no carry-in)', () => {
  it.each([
    [0, 0, 0, 0],
    [0, 1, 1, 0],
    [1, 0, 1, 0],
    [1, 1, 0, 1],
  ] as const)('a=%i b=%i -> sum=%i cout=%i', (a, b, sum, cout) => {
    const circuit = new Circuit();
    const vcc = makeSource(circuit, 1).pins.out;
    const gnd = makeSource(circuit, 0).pins.out;
    const ha = buildHalfAdder(circuit);
    const inA = makeInput(circuit, a);
    const inB = makeInput(circuit, b);
    wire(circuit, inA.pins.out, ha.a);
    wire(circuit, inB.pins.out, ha.b);

    const { netMap, state } = settle(circuit);
    expect(levelAt(state, netMap, ha.sum.id)).toBe(sum);
    expect(levelAt(state, netMap, ha.cout.id)).toBe(cout);
  });
});

describe('full adder (two XOR, two AND, one OR)', () => {
  it.each([
    [0, 0, 0, 0, 0],
    [0, 0, 1, 1, 0],
    [0, 1, 0, 1, 0],
    [0, 1, 1, 0, 1],
    [1, 0, 0, 1, 0],
    [1, 0, 1, 0, 1],
    [1, 1, 0, 0, 1],
    [1, 1, 1, 1, 1],
  ] as const)('a=%i b=%i cin=%i -> sum=%i cout=%i', (a, b, cin, sum, cout) => {
    const circuit = new Circuit();
    const vcc = makeSource(circuit, 1).pins.out;
    const gnd = makeSource(circuit, 0).pins.out;
    const adder = buildFullAdder(circuit);
    const inA = makeInput(circuit, a);
    const inB = makeInput(circuit, b);
    const inCin = makeInput(circuit, cin);
    wire(circuit, inA.pins.out, adder.a);
    wire(circuit, inB.pins.out, adder.b);
    wire(circuit, inCin.pins.out, adder.cin);

    const { netMap, state } = settle(circuit);
    expect(levelAt(state, netMap, adder.sum.id)).toBe(sum);
    expect(levelAt(state, netMap, adder.cout.id)).toBe(cout);
  });
});

describe('SR latch (2 cross-coupled NANDs, 8 transistors) — holds state via feedback', () => {
  it('set then hold then reset, active-low inputs', () => {
    const circuit = new Circuit();
    const vcc = makeSource(circuit, 1).pins.out;
    const gnd = makeSource(circuit, 0).pins.out;
    const latch = buildSrLatch(circuit);
    const s = makeInput(circuit, 1); // idle = 1 (active-low)
    const r = makeInput(circuit, 1);
    wire(circuit, s.pins.out, latch.setPin);
    wire(circuit, r.pins.out, latch.resetPin);

    const netMap = circuit.computeNets();
    let state = initialState();

    // S̄=0 pulses Q high.
    s.value = 0;
    for (let i = 0; i < 8; i++) state = step(circuit, netMap, state);
    expect(state.settled).toBe(true);
    expect(levelAt(state, netMap, latch.q.id)).toBe(1);
    expect(levelAt(state, netMap, latch.qn.id)).toBe(0);

    // Both idle (1,1): must hold Q=1.
    s.value = 1;
    for (let i = 0; i < 8; i++) state = step(circuit, netMap, state);
    expect(levelAt(state, netMap, latch.q.id)).toBe(1);

    // R̄=0 pulses Q low.
    r.value = 0;
    for (let i = 0; i < 8; i++) state = step(circuit, netMap, state);
    expect(levelAt(state, netMap, latch.q.id)).toBe(0);
    expect(levelAt(state, netMap, latch.qn.id)).toBe(1);

    // Both idle again: must hold Q=0.
    r.value = 1;
    for (let i = 0; i < 8; i++) state = step(circuit, netMap, state);
    expect(levelAt(state, netMap, latch.q.id)).toBe(0);
  });
});

describe('wire waypoints', () => {
  it('are purely cosmetic — a bent wire connects the same net as a straight one', () => {
    const circuit = new Circuit();
    const vcc = makeSource(circuit, 1);
    const gnd = makeSource(circuit, 0);
    circuit.addWire(vcc.pins.out.id, gnd.pins.out.id, [
      { x: 10, y: 10 },
      { x: 20, y: -5 },
    ]);

    const { netMap, state } = settle(circuit);
    // Same net either way, so this is still the short-circuit case, not a
    // new "waypoints changed the topology" behavior.
    const net = netMap.netOf.get(vcc.pins.out.id);
    expect(net).toBe(netMap.netOf.get(gnd.pins.out.id));
    expect(state.contended.has(net!)).toBe(true);
  });
});

describe('contention', () => {
  it('flags a net shorted between VCC and GND', () => {
    const circuit = new Circuit();
    const vcc = makeSource(circuit, 1);
    const gnd = makeSource(circuit, 0);
    wire(circuit, vcc.pins.out, gnd.pins.out);

    const netMap = circuit.computeNets();
    const state = step(circuit, netMap, initialState());
    const net = netMap.netOf.get(vcc.pins.out.id) as string;
    expect(state.contended.has(net)).toBe(true);
  });
});

describe('implicit rails', () => {
  it('drives a net named VCC from a label alone (no Source)', () => {
    const circuit = new Circuit();
    const led = makeLed(circuit, { x: 100, y: 100 });
    const label = makeLabel(circuit, 'VCC', { x: 40, y: 100 });
    wire(circuit, label.pins.net, led.pins.in);

    const { netMap, state } = settle(circuit);
    expect(netMap.netOf.get(led.pins.in.id)).toBe('VCC');
    expect(levelAt(state, netMap, led.pins.in.id)).toBe(1);
  });
});

describe('tri-state buffer (bus driver) — non-inverting, floats when disabled', () => {
  it.each([
    [0, 0],
    [1, 1],
  ] as const)('en=1, a=%i -> out=%i', (aVal, outVal) => {
    const circuit = new Circuit();
    const vcc = makeSource(circuit, 1).pins.out;
    const gnd = makeSource(circuit, 0).pins.out;
    const buf = buildTriStateBuffer(circuit);
    const en = makeInput(circuit, 1);
    const a = makeInput(circuit, aVal);
    wire(circuit, en.pins.out, buf.en);
    wire(circuit, a.pins.out, buf.a);

    const { netMap, state } = settle(circuit);
    expect(levelAt(state, netMap, buf.out.id)).toBe(outVal);
  });

  it('has no forced driver when en=0, regardless of a', () => {
    const circuit = new Circuit();
    const vcc = makeSource(circuit, 1).pins.out;
    const gnd = makeSource(circuit, 0).pins.out;
    const buf = buildTriStateBuffer(circuit);
    const en = makeInput(circuit, 0);
    const a = makeInput(circuit, 1);
    wire(circuit, en.pins.out, buf.en);
    wire(circuit, a.pins.out, buf.a);

    const netMap = circuit.computeNets();
    const net = netMap.netOf.get(buf.out.id)!;
    const state = step(circuit, netMap, initialState());
    // Never driven before, and nothing drives it now: capacitive hold has
    // nothing to hold, so it genuinely reads 'Z', not a guessed 0 or 1.
    expect(state.levelOf.get(net)).toBe('Z');
    expect(state.contended.has(net)).toBe(false);
  });

  it('holds its last driven level via capacitive hold once en drops', () => {
    const circuit = new Circuit();
    const vcc = makeSource(circuit, 1).pins.out;
    const gnd = makeSource(circuit, 0).pins.out;
    const buf = buildTriStateBuffer(circuit);
    const en = makeInput(circuit, 1);
    const a = makeInput(circuit, 1);
    wire(circuit, en.pins.out, buf.en);
    wire(circuit, a.pins.out, buf.a);

    const netMap = circuit.computeNets();
    let state = initialState();
    for (let i = 0; i < 8; i++) state = step(circuit, netMap, state);
    const net = netMap.netOf.get(buf.out.id)!;
    expect(state.levelOf.get(net)).toBe(1);

    en.value = 0; // release the bus
    for (let i = 0; i < 8; i++) state = step(circuit, netMap, state);
    expect(state.levelOf.get(net)).toBe(1); // nothing drives it, but the wire "remembers"
  });

  /**
   * Two disagreeing enabled drivers on one net don't settle to a clean,
   * quiet `contended` state — they oscillate forever. The short ties VCC's
   * *own* net and GND's *own* net together (both rails are just ordinary
   * nets to this solver, not idealized zero-impedance sources immune to
   * being merged), so `forced.size > 1` sets *their* reported level to 'Z'
   * for that pass too — which starves the very `buildNot` gates whose
   * stable output was gating the fight, breaking it; next pass those gates
   * recover (their real driver, `a`/`en`, never moved), the short re-forms,
   * and the cycle repeats. `settled` never becomes true here, and that's
   * the correct signal: a real short has no valid Boolean answer, and this
   * is a switch-level model without ideal supply rails, not a place to
   * pretend one exists. What must never happen is the opposite failure —
   * the fight quietly resolving to an unflagged, confidently wrong 0 or 1 —
   * so this checks that `contended` genuinely fires across the oscillation,
   * not just on whichever single pass a caller happens to stop at.
   */
  it('never settles when two enabled buffers disagree — contention keeps firing, it never goes quiet', () => {
    const circuit = new Circuit();
    const vcc = makeSource(circuit, 1).pins.out;
    const gnd = makeSource(circuit, 0).pins.out;
    const buf1 = buildTriStateBuffer(circuit, { x: 0, y: 0 });
    const buf2 = buildTriStateBuffer(circuit, { x: 0, y: 600 });
    const en1 = makeInput(circuit, 1);
    const en2 = makeInput(circuit, 1);
    const a1 = makeInput(circuit, 1);
    const a2 = makeInput(circuit, 0);
    wire(circuit, en1.pins.out, buf1.en);
    wire(circuit, a1.pins.out, buf1.a);
    wire(circuit, en2.pins.out, buf2.en);
    wire(circuit, a2.pins.out, buf2.a);
    wire(circuit, buf1.out, buf2.out); // tie both drivers onto the same bus net

    const netMap = circuit.computeNets();
    const net = netMap.netOf.get(buf1.out.id)!;
    let state = initialState();
    let sawContention = false;
    let sawSettled = false;
    for (let i = 0; i < 10; i++) {
      state = step(circuit, netMap, state, 1); // one relaxation pass per call, to see every phase of the oscillation
      if (state.contended.has(net)) sawContention = true;
      if (state.settled) sawSettled = true;
    }
    expect(sawContention).toBe(true);
    expect(sawSettled).toBe(false);
  });
});

describe('address decoder (one-hot)', () => {
  it('a 2-bit address selects exactly one of 4 lines', () => {
    const circuit = new Circuit();
    const vcc = makeSource(circuit, 1).pins.out;
    const gnd = makeSource(circuit, 0).pins.out;
    const dec = buildDecoder(circuit, 2);
    expect(dec.addr).toHaveLength(2);
    expect(dec.lines).toHaveLength(4);

    const a0 = makeInput(circuit, 0);
    const a1 = makeInput(circuit, 0);
    wire(circuit, a0.pins.out, dec.addr[0]!);
    wire(circuit, a1.pins.out, dec.addr[1]!);

    const cases: [0 | 1, 0 | 1, number][] = [
      [0, 0, 0],
      [1, 0, 1],
      [0, 1, 2],
      [1, 1, 3],
    ];
    for (const [v0, v1, selected] of cases) {
      a0.value = v0;
      a1.value = v1;
      const { netMap, state } = settle(circuit);
      for (let i = 0; i < 4; i++) {
        expect(levelAt(state, netMap, dec.lines[i]!.id)).toBe(i === selected ? 1 : 0);
      }
    }
  });

  it('a single address bit needs no AND gates at all — just the bit and its inverse', () => {
    const circuit = new Circuit();
    makeSource(circuit, 1); // rail driver
    makeSource(circuit, 0);
    const dec = buildDecoder(circuit, 1);
    expect(dec.lines).toHaveLength(2);

    const a0 = makeInput(circuit, 1);
    wire(circuit, a0.pins.out, dec.addr[0]!);

    const { netMap, state } = settle(circuit);
    expect(levelAt(state, netMap, dec.lines[0]!.id)).toBe(0);
    expect(levelAt(state, netMap, dec.lines[1]!.id)).toBe(1);
  });
});
