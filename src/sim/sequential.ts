// Storage built from the gates in library.ts: a level-sensitive D-latch,
// then a master-slave D flip-flop built from two of them. This is the
// missing piece between "gates" and "registers" — every register bit in
// the eventual CPU is one of these, replicated and wired to a shared clock.

import type { Circuit } from './Circuit.js';
import { buildMux2, buildNand, buildNot, buildSrLatch, wire } from './library.js';
import type { Pin, Point } from './types.js';

export interface DLatch {
  d: Pin;
  en: Pin;
  q: Pin;
  qn: Pin;
}

/**
 * Gated D-latch, transparent while `en` is high, holding whatever `d` was
 * the instant `en` last fell low.
 *
 * This is the textbook 4-NAND-plus-inverter latch: `n1 = NAND(d, en)` and
 * `n2 = NAND(¬d, en)` are exactly the active-low set/reset pair the
 * cross-coupled buildSrLatch() already expects, so this reuses it outright
 * rather than re-deriving the same feedback loop. Worked through:
 * `en=1` → n1=¬d, n2=d → set when d=1, reset when d=0 (transparent).
 * `en=0` → n1=n2=1 → both latch inputs inactive → hold (the SR latch's own
 * cross-coupled feedback keeps whatever level it last saw).
 */
export function buildDLatch(circuit: Circuit, vcc: Pin, gnd: Pin, pos: Point = { x: 0, y: 0 }): DLatch {
  const notD = buildNot(circuit, vcc, gnd, pos);
  const nand1 = buildNand(circuit, vcc, gnd, { x: pos.x + 150, y: pos.y });
  const nand2 = buildNand(circuit, vcc, gnd, { x: pos.x + 150, y: pos.y + 150 });
  const latch = buildSrLatch(circuit, vcc, gnd, { x: pos.x + 350, y: pos.y });

  wire(circuit, notD.in, nand1.a); // external D also feeds the inverter's input directly
  wire(circuit, notD.out, nand2.a);
  wire(circuit, nand1.b, nand2.b); // shared EN
  wire(circuit, nand1.out, latch.setPin);
  wire(circuit, nand2.out, latch.resetPin);

  return { d: notD.in, en: nand1.b, q: latch.q, qn: latch.qn };
}

export interface DFlipFlop {
  d: Pin;
  clk: Pin;
  q: Pin;
  qn: Pin;
}

/**
 * Positive-edge-triggered D flip-flop: the classic master-slave pair — a
 * master latch transparent while CLK is low (tracking D), a slave latch
 * transparent while CLK is high (passing the master's value through).
 * On the low-to-high edge the master closes first, freezing at the D value
 * it last saw, and the slave opens onto exactly that frozen value — no
 * explicit sequencing needed, it falls out of the topology, the same way
 * buildSrLatch's feedback loop needs no special-casing in the solver.
 */
export function buildDFlipFlop(circuit: Circuit, vcc: Pin, gnd: Pin, pos: Point = { x: 0, y: 0 }): DFlipFlop {
  const clkInv = buildNot(circuit, vcc, gnd, pos);
  const master = buildDLatch(circuit, vcc, gnd, { x: pos.x + 150, y: pos.y });
  const slave = buildDLatch(circuit, vcc, gnd, { x: pos.x + 800, y: pos.y });

  wire(circuit, clkInv.out, master.en); // master transparent while CLK=0
  wire(circuit, clkInv.in, slave.en); // slave transparent while CLK=1
  wire(circuit, master.q, slave.d);

  return { d: master.d, clk: clkInv.in, q: slave.q, qn: slave.qn };
}

export interface RegisterBit {
  d: Pin;
  we: Pin;
  clk: Pin;
  q: Pin;
  qn: Pin;
}

/**
 * One register bit: a D flip-flop whose D input is fed through a 2:1 mux
 * choosing between the new value (`we`=1) and its own current Q fed back
 * (`we`=0) — so it re-latches its own value every clock edge while
 * disabled. This is the standard way to make a synchronous register
 * writable-on-demand *without* gating the clock line itself (gating clocks
 * is how you get glitches in real hardware; gating the data input, as
 * every actual CPU register file does, is not).
 */
export function buildRegisterBit(circuit: Circuit, vcc: Pin, gnd: Pin, pos: Point = { x: 0, y: 0 }): RegisterBit {
  const mux = buildMux2(circuit, vcc, gnd, pos);
  const dff = buildDFlipFlop(circuit, vcc, gnd, { x: pos.x + 1200, y: pos.y });

  wire(circuit, mux.out, dff.d);
  wire(circuit, dff.q, mux.in0); // WE=0: hold (feed Q back into D)

  return { d: mux.in1, we: mux.sel, clk: dff.clk, q: dff.q, qn: dff.qn };
}
