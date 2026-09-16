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
import { seedLabCells, isLabcellName } from './labcells.js';
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
): ChipDef | undefined {
  if (library.findByName(name)) return undefined;
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

/**
 * Drop extra chip defs that share a display name with another def and are
 * not referenced by any instance. Sessions used to re-seed stdcells on every
 * load, leaving orphan duplicates (same name, new id) in the Library menu.
 */
export function pruneDuplicateChipNames(library: ChipLibrary, roots: Circuit[]): number {
  const referenced = new Set<string>();
  const mark = (circuit: Circuit): void => {
    for (const c of circuit.components.values()) {
      if (c.kind === 'chip') referenced.add(c.defId);
    }
  };
  for (const root of roots) mark(root);
  for (const def of library.list()) mark(def.circuit);

  const byName = new Map<string, ChipDef[]>();
  for (const def of library.list()) {
    const list = byName.get(def.name) ?? [];
    list.push(def);
    byName.set(def.name, list);
  }

  let removed = 0;
  for (const defs of byName.values()) {
    if (defs.length < 2) continue;
    const keep = new Set<string>();
    for (const d of defs) {
      if (referenced.has(d.id)) keep.add(d.id);
    }
    if (keep.size === 0) keep.add(defs[0]!.id);
    for (const d of defs) {
      if (keep.has(d.id)) continue;
      library.remove(d.id);
      removed++;
    }
  }
  return removed;
}

/** Display names of chips seeded by `seedStandardCells` (for library tags). */
export const STDCELL_NAMES = new Set([
  'NOT',
  'NAND',
  'AND',
  'NOR',
  'OR',
  'XOR',
  'MUX2',
  'MUX4',
  'HALF_ADDER',
  'FULL_ADDER',
  'D_LATCH',
  'D_FF',
  'TRI_BUF',
]);

export function isStdcellName(name: string): boolean {
  return STDCELL_NAMES.has(name) || isLabcellName(name);
}

/** Registers NOT, NAND, AND, NOR, OR, XOR, MUX2, MUX4, HALF_ADDER, FULL_ADDER, D_LATCH, D_FF and TRI_BUF as placeable chips. Idempotent by name. */
export function seedStandardCells(library: ChipLibrary): void {
  if (!library.findByName('NOT')) {
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

  if (!library.findByName('MUX2')) {
    const circuit = scratch();
    const m = buildMux2(circuit);
    foldExposing(circuit, 'MUX2', library, [
      { pin: m.sel, isOutput: false, portName: 'sel' },
      { pin: m.in0, isOutput: false, portName: 'in0' },
      { pin: m.in1, isOutput: false, portName: 'in1' },
      { pin: m.out, isOutput: true, portName: 'out' },
    ]);
  }

  if (!library.findByName('MUX4')) {
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

  if (!library.findByName('HALF_ADDER')) {
    const circuit = scratch();
    const h = buildHalfAdder(circuit);
    foldExposing(circuit, 'HALF_ADDER', library, [
      { pin: h.a, isOutput: false, portName: 'a' },
      { pin: h.b, isOutput: false, portName: 'b' },
      { pin: h.sum, isOutput: true, portName: 'sum' },
      { pin: h.cout, isOutput: true, portName: 'cout' },
    ]);
  }

  if (!library.findByName('FULL_ADDER')) {
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

  if (!library.findByName('D_LATCH')) {
    const circuit = scratch();
    const l = buildDLatch(circuit);
    foldExposing(circuit, 'D_LATCH', library, [
      { pin: l.d, isOutput: false, portName: 'd' },
      { pin: l.en, isOutput: false, portName: 'en' },
      { pin: l.q, isOutput: true, portName: 'q' },
      { pin: l.qn, isOutput: true, portName: 'qn' },
    ]);
  }

  if (!library.findByName('D_FF')) {
    const circuit = scratch();
    const f = buildDFlipFlop(circuit);
    foldExposing(circuit, 'D_FF', library, [
      { pin: f.d, isOutput: false, portName: 'd' },
      { pin: f.clk, isOutput: false, portName: 'clk' },
      { pin: f.q, isOutput: true, portName: 'q' },
      { pin: f.qn, isOutput: true, portName: 'qn' },
    ]);
  }

  if (!library.findByName('TRI_BUF')) {
    const circuit = scratch();
    const b = buildTriStateBuffer(circuit);
    foldExposing(circuit, 'TRI_BUF', library, [
      { pin: b.a, isOutput: false, portName: 'a' },
      { pin: b.en, isOutput: false, portName: 'en' },
      { pin: b.out, isOutput: true, portName: 'out' },
    ]);
  }

  // Pack A/B/C hierarchical lab cells + 74xx aliases (idempotent by name).
  seedLabCells(library);
}
