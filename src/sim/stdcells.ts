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
  // NAND/NOR are CMOS primitives — keep drawn wires. AND/OR/XOR are
  // composites of those; labelize their interconnects.
  const labelize = name !== 'NAND' && name !== 'NOR';
  return foldExposing(circuit, name, library, [
    { pin: g.a, isOutput: false, portName: 'a' },
    { pin: g.b, isOutput: false, portName: 'b' },
    { pin: g.out, isOutput: true, portName: 'out' },
  ], { labelize });
}

/** Registers NOT, NAND, AND, NOR, OR, XOR, MUX2, MUX4, HALF_ADDER, FULL_ADDER, D_LATCH, D_FF and TRI_BUF as placeable chips. */
export function seedStandardCells(library: ChipLibrary): void {
  {
    const circuit = scratch();
    const g = buildNot(circuit);
    foldExposing(circuit, 'NOT', library, [
      { pin: g.in, isOutput: false, portName: 'in' },
      { pin: g.out, isOutput: true, portName: 'out' },
    ], { labelize: false });
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
      { pin: m.sel, isOutput: false, portName: 'sel' },
      { pin: m.in0, isOutput: false, portName: 'in0' },
      { pin: m.in1, isOutput: false, portName: 'in1' },
      { pin: m.out, isOutput: true, portName: 'out' },
    ]);
  }

  {
    const circuit = scratch();
    const m = buildMux4(circuit);
    foldExposing(circuit, 'MUX4', library, [
      { pin: m.sel0, isOutput: false, portName: 'sel0' },
      { pin: m.sel1, isOutput: false, portName: 'sel1' },
      { pin: m.in0, isOutput: false, portName: 'in0' },
      { pin: m.in1, isOutput: false, portName: 'in1' },
      { pin: m.in2, isOutput: false, portName: 'in2' },
      { pin: m.in3, isOutput: false, portName: 'in3' },
      { pin: m.out, isOutput: true, portName: 'out' },
    ]);
  }

  {
    const circuit = scratch();
    const h = buildHalfAdder(circuit);
    foldExposing(circuit, 'HALF_ADDER', library, [
      { pin: h.a, isOutput: false, portName: 'a' },
      { pin: h.b, isOutput: false, portName: 'b' },
      { pin: h.sum, isOutput: true, portName: 'sum' },
      { pin: h.cout, isOutput: true, portName: 'cout' },
    ]);
  }

  {
    const circuit = scratch();
    const f = buildFullAdder(circuit);
    foldExposing(circuit, 'FULL_ADDER', library, [
      { pin: f.a, isOutput: false, portName: 'a' },
      { pin: f.b, isOutput: false, portName: 'b' },
      { pin: f.cin, isOutput: false, portName: 'cin' },
      { pin: f.sum, isOutput: true, portName: 'sum' },
      { pin: f.cout, isOutput: true, portName: 'cout' },
    ]);
  }

  {
    const circuit = scratch();
    const l = buildDLatch(circuit);
    foldExposing(circuit, 'D_LATCH', library, [
      { pin: l.d, isOutput: false, portName: 'd' },
      { pin: l.en, isOutput: false, portName: 'en' },
      { pin: l.q, isOutput: true, portName: 'q' },
      { pin: l.qn, isOutput: true, portName: 'qn' },
    ]);
  }

  {
    const circuit = scratch();
    const f = buildDFlipFlop(circuit);
    foldExposing(circuit, 'D_FF', library, [
      { pin: f.d, isOutput: false, portName: 'd' },
      { pin: f.clk, isOutput: false, portName: 'clk' },
      { pin: f.q, isOutput: true, portName: 'q' },
      { pin: f.qn, isOutput: true, portName: 'qn' },
    ]);
  }

  {
    const circuit = scratch();
    const b = buildTriStateBuffer(circuit);
    foldExposing(circuit, 'TRI_BUF', library, [
      { pin: b.a, isOutput: false, portName: 'a' },
      { pin: b.en, isOutput: false, portName: 'en' },
      { pin: b.out, isOutput: true, portName: 'out' },
    ]);
  }
}
