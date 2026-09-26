// Registers a standard library of pre-folded chips in a ChipLibrary — gates
// through simple sequential elements — so they show up in the UI's chip
// palette immediately, placeable and wireable like any other chip, without
// first hand-building each one from raw transistors. Mirrors the reference
// project's own ready-made "Library (42 items)" palette.

import type { ChipDef } from './ChipLibrary.js';
import { ChipLibrary } from './ChipLibrary.js';
import { bumpStructureVersion, Circuit } from './Circuit.js';
import { foldExposing, relayoutCmosPrimitivePorts } from './hierarchy.js';
import {
  buildAnd,
  buildFullAdder,
  buildHalfAdder,
  buildMux2,
  buildMux2Tg,
  buildMux4,
  buildNand,
  buildNor,
  buildNot,
  buildOr,
  buildTriStateBuffer,
  buildXor,
  makeChipGatePlacer,
  makeSource,
  setCircuitGatePlacer,
  type CircuitGatePlacer,
  type TwoInputGate,
} from './library.js';
import { seedLabCells, isLabcellName } from './labcells.js';
import { buildDFlipFlop, buildDLatch } from './sequential.js';
import type { Pin } from './types.js';

/** When CMOS pitch/port layout changes, existing session defs with a smaller
 * transistor span are rebuilt in place (same def.id) so autosaves pick it up. */
function cmosTransistorSpan(def: ChipDef): number {
  const ys: number[] = [];
  for (const c of def.circuit.components.values()) {
    if (c.kind === 'transistor') ys.push(c.pos.y);
  }
  if (ys.length < 2) return 0;
  return Math.max(...ys) - Math.min(...ys);
}

/** True when two+ input ports share nearly the same Y (the glued IN a/b bug). */
function cmosInputPortsGlued(def: ChipDef): boolean {
  const ys: number[] = [];
  for (const c of def.circuit.components.values()) {
    if (c.kind !== 'port') continue;
    if (c.dir === 'out') continue;
    ys.push(c.pos.y);
  }
  if (ys.length < 2) return false;
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  return max - min < 48;
}

function refreshCmosDef(
  library: ChipLibrary,
  name: string,
  minSpan: number,
  build: () => { circuit: Circuit; ports: { pin: Pin; isOutput: boolean; portName: string }[] },
): void {
  const existing = library.findByName(name);
  const stale =
    !existing ||
    cmosTransistorSpan(existing) + 1 < minSpan ||
    cmosInputPortsGlued(existing);
  if (existing && !stale) return;

  const { circuit, ports } = build();
  if (!existing) {
    foldExposing(circuit, name, library, ports, { labelize: false });
    return;
  }
  const tmp = new ChipLibrary();
  const fresh = foldExposing(circuit, name, tmp, ports, { labelize: false });
  existing.circuit = fresh.circuit;
  existing.ports = [...fresh.ports];
  existing.revision = (existing.revision ?? 0) + 1;
  bumpStructureVersion();
}

/**
 * Re-park ports on every transistor-only def (canonical CMOS + dive forks
 * like NAND_copy). Cheap, and fixes glued IN a/b left behind when a prior
 * pitch refresh skipped a second port pass.
 */
export function relayoutAllCmosLibraryPorts(library: ChipLibrary): void {
  for (const def of library.list()) {
    let hasT = false;
    let hasChip = false;
    for (const c of def.circuit.components.values()) {
      if (c.kind === 'transistor') hasT = true;
      if (c.kind === 'chip') hasChip = true;
    }
    if (hasT && !hasChip) relayoutCmosPrimitivePorts(def);
  }
}

function scratch(): Circuit {
  const circuit = new Circuit();
  makeSource(circuit, 1); // rail driver for tiePowerRail VCC
  makeSource(circuit, 0); // rail driver for tiePowerRail GND
  return circuit;
}

function requireDef(library: ChipLibrary, name: string): ChipDef {
  const def = library.findByName(name);
  if (!def) throw new Error(`seedStandardCells: expected ${name} to be registered first`);
  return def;
}

/** Gate placers for composites — primitives must already be in the library. */
function primitiveGatePlacer(library: ChipLibrary): CircuitGatePlacer {
  return makeChipGatePlacer({
    not: requireDef(library, 'NOT'),
    nand: requireDef(library, 'NAND'),
    and: requireDef(library, 'AND'),
    nor: requireDef(library, 'NOR'),
    or: requireDef(library, 'OR'),
    // xor omitted → expands to 4× NAND chips while seeding XOR itself
  });
}

function fullGatePlacer(library: ChipLibrary): CircuitGatePlacer {
  return makeChipGatePlacer({
    not: requireDef(library, 'NOT'),
    nand: requireDef(library, 'NAND'),
    and: requireDef(library, 'AND'),
    nor: requireDef(library, 'NOR'),
    or: requireDef(library, 'OR'),
    xor: requireDef(library, 'XOR'),
  });
}

function muxTreePlacer(library: ChipLibrary): CircuitGatePlacer {
  return makeChipGatePlacer({
    not: requireDef(library, 'NOT'),
    nand: requireDef(library, 'NAND'),
    and: requireDef(library, 'AND'),
    nor: requireDef(library, 'NOR'),
    or: requireDef(library, 'OR'),
    xor: requireDef(library, 'XOR'),
    mux2: requireDef(library, 'MUX2'),
  });
}

function dffGatePlacer(library: ChipLibrary): CircuitGatePlacer {
  return makeChipGatePlacer({
    not: requireDef(library, 'NOT'),
    nand: requireDef(library, 'NAND'),
    and: requireDef(library, 'AND'),
    nor: requireDef(library, 'NOR'),
    or: requireDef(library, 'OR'),
    xor: requireDef(library, 'XOR'),
    dLatch: requireDef(library, 'D_LATCH'),
  });
}

function withPlacer<T>(circuit: Circuit, placer: CircuitGatePlacer, build: () => T): T {
  setCircuitGatePlacer(circuit, placer);
  try {
    return build();
  } finally {
    setCircuitGatePlacer(circuit, null);
  }
}

/** CMOS primitives: transistor schematic, drawn wires kept. */
function seedCmosTwoInput(
  library: ChipLibrary,
  name: string,
  build: (circuit: Circuit) => TwoInputGate,
): void {
  // Always reseat guts so expose-pin / pitch / port-routing upgrades land on
  // autosaved libraries (span checks alone missed "new pitch, old B pin").
  refreshCmosDef(library, name, Number.POSITIVE_INFINITY, () => {
    const circuit = scratch();
    const g = build(circuit);
    return {
      circuit,
      ports: [
        { pin: g.a, isOutput: false, portName: 'a' },
        { pin: g.b, isOutput: false, portName: 'b' },
        { pin: g.out, isOutput: true, portName: 'out' },
      ],
    };
  });
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
  'MUX2_TG',
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

/**
 * Registers NOT, NAND, AND, NOR, OR, XOR, MUX2, MUX2_TG, MUX4, HALF_ADDER,
 * FULL_ADDER, D_LATCH, D_FF and TRI_BUF as placeable chips. Idempotent by name.
 *
 * Dive layers:
 *   CMOS primitives (NOT/NAND/AND/NOR/OR/TRI_BUF/MUX2_TG) → transistor schematic
 *   XOR / MUX2 / adders → gate chip instances → dive again for CMOS
 *   D_LATCH → NOT/NAND chips; D_FF → NOT + two D_LATCH
 *   MUX4 → three MUX2 chips
 */
export function seedStandardCells(library: ChipLibrary): void {
  refreshCmosDef(library, 'NOT', Number.POSITIVE_INFINITY, () => {
    const circuit = scratch();
    const g = buildNot(circuit);
    return {
      circuit,
      ports: [
        { pin: g.in, isOutput: false, portName: 'in' },
        { pin: g.out, isOutput: true, portName: 'out' },
      ],
    };
  });

  seedCmosTwoInput(library, 'NAND', buildNand);
  seedCmosTwoInput(library, 'AND', buildAnd);
  seedCmosTwoInput(library, 'NOR', buildNor);
  seedCmosTwoInput(library, 'OR', buildOr);

  if (!library.findByName('XOR')) {
    const circuit = scratch();
    const g = withPlacer(circuit, primitiveGatePlacer(library), () => buildXor(circuit));
    foldExposing(circuit, 'XOR', library, [
      { pin: g.a, isOutput: false, portName: 'a' },
      { pin: g.b, isOutput: false, portName: 'b' },
      { pin: g.out, isOutput: true, portName: 'out' },
    ], { labelize: false });
  }

  if (!library.findByName('MUX2')) {
    const circuit = scratch();
    const m = withPlacer(circuit, primitiveGatePlacer(library), () => buildMux2(circuit));
    foldExposing(circuit, 'MUX2', library, [
      { pin: m.sel, isOutput: false, portName: 'sel' },
      { pin: m.in0, isOutput: false, portName: 'in0' },
      { pin: m.in1, isOutput: false, portName: 'in1' },
      { pin: m.out, isOutput: true, portName: 'out' },
    ], { labelize: false });
  }

  refreshCmosDef(library, 'MUX2_TG', Number.POSITIVE_INFINITY, () => {
    const circuit = scratch();
    const m = buildMux2Tg(circuit);
    return {
      circuit,
      ports: [
        { pin: m.sel, isOutput: false, portName: 'sel' },
        { pin: m.in0, isOutput: false, portName: 'in0' },
        { pin: m.in1, isOutput: false, portName: 'in1' },
        { pin: m.out, isOutput: true, portName: 'out' },
      ],
    };
  });

  if (!library.findByName('MUX4')) {
    const circuit = scratch();
    const m = withPlacer(circuit, muxTreePlacer(library), () => buildMux4(circuit));
    foldExposing(circuit, 'MUX4', library, [
      { pin: m.sel0, isOutput: false, portName: 'sel0' },
      { pin: m.sel1, isOutput: false, portName: 'sel1' },
      { pin: m.in0, isOutput: false, portName: 'in0' },
      { pin: m.in1, isOutput: false, portName: 'in1' },
      { pin: m.in2, isOutput: false, portName: 'in2' },
      { pin: m.in3, isOutput: false, portName: 'in3' },
      { pin: m.out, isOutput: true, portName: 'out' },
    ], { labelize: false });
  }

  if (!library.findByName('HALF_ADDER')) {
    const circuit = scratch();
    const h = withPlacer(circuit, fullGatePlacer(library), () => buildHalfAdder(circuit));
    foldExposing(circuit, 'HALF_ADDER', library, [
      { pin: h.a, isOutput: false, portName: 'a' },
      { pin: h.b, isOutput: false, portName: 'b' },
      { pin: h.sum, isOutput: true, portName: 'sum' },
      { pin: h.cout, isOutput: true, portName: 'cout' },
    ], { labelize: false });
  }

  if (!library.findByName('FULL_ADDER')) {
    const circuit = scratch();
    const f = withPlacer(circuit, fullGatePlacer(library), () => buildFullAdder(circuit));
    foldExposing(circuit, 'FULL_ADDER', library, [
      { pin: f.a, isOutput: false, portName: 'a' },
      { pin: f.b, isOutput: false, portName: 'b' },
      { pin: f.cin, isOutput: false, portName: 'cin' },
      { pin: f.sum, isOutput: true, portName: 'sum' },
      { pin: f.cout, isOutput: true, portName: 'cout' },
    ], { labelize: false });
  }

  if (!library.findByName('D_LATCH')) {
    const circuit = scratch();
    const l = withPlacer(circuit, primitiveGatePlacer(library), () => buildDLatch(circuit));
    foldExposing(circuit, 'D_LATCH', library, [
      { pin: l.d, isOutput: false, portName: 'd' },
      { pin: l.en, isOutput: false, portName: 'en' },
      { pin: l.q, isOutput: true, portName: 'q' },
      { pin: l.qn, isOutput: true, portName: 'qn' },
    ], { labelize: false });
  }

  if (!library.findByName('D_FF')) {
    const circuit = scratch();
    const f = withPlacer(circuit, dffGatePlacer(library), () => buildDFlipFlop(circuit));
    foldExposing(circuit, 'D_FF', library, [
      { pin: f.d, isOutput: false, portName: 'd' },
      { pin: f.clk, isOutput: false, portName: 'clk' },
      { pin: f.q, isOutput: true, portName: 'q' },
      { pin: f.qn, isOutput: true, portName: 'qn' },
    ], { labelize: false });
  }

  refreshCmosDef(library, 'TRI_BUF', Number.POSITIVE_INFINITY, () => {
    const circuit = scratch();
    const b = buildTriStateBuffer(circuit);
    return {
      circuit,
      ports: [
        { pin: b.a, isOutput: false, portName: 'a' },
        { pin: b.en, isOutput: false, portName: 'en' },
        { pin: b.out, isOutput: true, portName: 'out' },
      ],
    };
  });

  // Pack A/B/C hierarchical lab cells + 74xx aliases (idempotent by name).
  seedLabCells(library);

  // Always re-park CMOS ports — catches NAND_copy forks and defs that already
  // had the new transistor pitch but kept glued IN a/IN b from an older pass.
  relayoutAllCmosLibraryPorts(library);
}
