// Registers a standard library of pre-folded chips in a ChipLibrary — gates
// through simple sequential elements — so they show up in the UI's chip
// palette immediately, placeable and wireable like any other chip, without
// first hand-building each one from raw transistors. Mirrors the reference
// project's own ready-made "Library (42 items)" palette.

import type { ChipDef, ChipLibrary } from './ChipLibrary.js';
import { Circuit } from './Circuit.js';
import { foldExposing } from './hierarchy.js';
import {
  buildAnd,
  buildFullAdder,
  buildHalfAdder,
  buildMux2,
  buildMux4,
  buildNand,
  buildNor,
  buildNot,
  buildOr,
  buildTriStateBuffer,
  buildXor,
  makeSource,
  type TwoInputGate,
} from './library.js';
import { buildDFlipFlop, buildDLatch } from './sequential.js';

function scratch(): Circuit {
  const circuit = new Circuit();
  makeSource(circuit, 1); // rail driver for tiePowerRail VCC
  makeSource(circuit, 0); // rail driver for tiePowerRail GND
  return circuit;
}

function seedTwoInputGate(
  library: ChipLibrary,
  name: string,
  build: (circuit: Circuit) => TwoInputGate,
): ChipDef {
  const circuit = scratch();
  const g = build(circuit);
  return foldExposing(circuit, name, library, [
    { pin: g.a, isOutput: false },
    { pin: g.b, isOutput: false },
    { pin: g.out, isOutput: true },
  ]);
}

/** Registers NOT, NAND, AND, NOR, OR, XOR, MUX2, MUX4, HALF_ADDER, FULL_ADDER, D_LATCH, D_FF and TRI_BUF as placeable chips. */
export function seedStandardCells(library: ChipLibrary): void {
  {
    const circuit = scratch();
    const g = buildNot(circuit);
    foldExposing(circuit, 'NOT', library, [
      { pin: g.in, isOutput: false },
      { pin: g.out, isOutput: true },
    ]);
  }

  seedTwoInputGate(library, 'NAND', buildNand);
  seedTwoInputGate(library, 'AND', buildAnd);
  seedTwoInputGate(library, 'NOR', buildNor);
  seedTwoInputGate(library, 'OR', buildOr);
  seedTwoInputGate(library, 'XOR', buildXor);

  {
    const circuit = scratch();
    const m = buildMux2(circuit);
    foldExposing(circuit, 'MUX2', library, [
      { pin: m.sel, isOutput: false },
      { pin: m.in0, isOutput: false },
      { pin: m.in1, isOutput: false },
      { pin: m.out, isOutput: true },
    ]);
  }

  {
    const circuit = scratch();
    const m = buildMux4(circuit);
    foldExposing(circuit, 'MUX4', library, [
      { pin: m.sel0, isOutput: false },
      { pin: m.sel1, isOutput: false },
      { pin: m.in0, isOutput: false },
      { pin: m.in1, isOutput: false },
      { pin: m.in2, isOutput: false },
      { pin: m.in3, isOutput: false },
      { pin: m.out, isOutput: true },
    ]);
  }

  {
    const circuit = scratch();
    const h = buildHalfAdder(circuit);
    foldExposing(circuit, 'HALF_ADDER', library, [
      { pin: h.a, isOutput: false },
      { pin: h.b, isOutput: false },
      { pin: h.sum, isOutput: true },
      { pin: h.cout, isOutput: true },
    ]);
  }

  {
    const circuit = scratch();
    const f = buildFullAdder(circuit);
    foldExposing(circuit, 'FULL_ADDER', library, [
      { pin: f.a, isOutput: false },
      { pin: f.b, isOutput: false },
      { pin: f.cin, isOutput: false },
      { pin: f.sum, isOutput: true },
      { pin: f.cout, isOutput: true },
    ]);
  }

  {
    const circuit = scratch();
    const l = buildDLatch(circuit);
    foldExposing(circuit, 'D_LATCH', library, [
      { pin: l.d, isOutput: false },
      { pin: l.en, isOutput: false },
      { pin: l.q, isOutput: true },
      { pin: l.qn, isOutput: true },
    ]);
  }

  {
    const circuit = scratch();
    const f = buildDFlipFlop(circuit);
    foldExposing(circuit, 'D_FF', library, [
      { pin: f.d, isOutput: false },
      { pin: f.clk, isOutput: false },
      { pin: f.q, isOutput: true },
      { pin: f.qn, isOutput: true },
    ]);
  }

  {
    const circuit = scratch();
    const b = buildTriStateBuffer(circuit);
    foldExposing(circuit, 'TRI_BUF', library, [
      { pin: b.a, isOutput: false },
      { pin: b.en, isOutput: false },
      { pin: b.out, isOutput: true },
    ]);
  }
}
