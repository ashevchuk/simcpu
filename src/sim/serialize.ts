// Persistence: turning a Circuit/ChipLibrary into plain JSON and back.
//
// Every type in types.ts was already plain data with no circular references
// (Pin points at its owner by *id*, not by object reference) — so most of
// this file is just "Map -> array and back". Two things aren't trivial:
//
// - RamComponent.bytes is a Uint8Array, the one field in the whole data
//   model that isn't already JSON-shaped (JSON.stringify turns it into
//   `{"0":1,"1":2,...}`, an object with numeric string keys, not an array
//   — JSON.parse would hand that back as-is, with no `.length` and none of
//   Uint8Array's methods, quietly corrupting every RAM the moment a project
//   round-trips through save/load). `toSerializedComponent`/
//   `fromSerializedComponent` below convert it to/from a plain `number[]`
//   at the boundary; nothing else in this file needs to know RAM exists.
// - Importing a *single* chip def into an already-running session
//   (importChipDef): its ids were assigned by some other session's own
//   counter, so they can collide with ids already in use here, and it may
//   itself depend on other chip defs that need to come along with it.
//   Loading a whole *project* (deserializeProject) doesn't have that problem
//   — it replaces the running session's state outright, so there's nothing
//   yet to collide with.

import { ChipLibrary, type ChipDef } from './ChipLibrary.js';
import { bumpStructureVersion, Circuit, nextId, noteUsedId } from './Circuit.js';
import { applyPinLayout, isOrientable } from './orientation.js';
import type {
  ChipInstanceComponent,
  ClockComponent,
  Component,
  Level,
  Pin,
  RamComponent,
  RomComponent,
  Wire,
} from './types.js';

/** Every Component variant, except memory `bytes` is a plain number array instead of a Uint8Array — see the file header for why. */
type SerializedComponent =
  | Exclude<Component, RamComponent | RomComponent>
  | (Omit<RamComponent, 'bytes'> & { bytes: number[] })
  | (Omit<RomComponent, 'bytes'> & { bytes: number[] });

function toSerializedComponent(c: Component): SerializedComponent {
  return c.kind === 'ram' || c.kind === 'rom' ? { ...c, bytes: Array.from(c.bytes) } : c;
}

function fromSerializedComponent(c: SerializedComponent): Component {
  if (c.kind === 'ram' || c.kind === 'rom') {
    return { ...c, bytes: Uint8Array.from(c.bytes) };
  }
  if (c.kind === 'port') {
    return { ...c, dir: c.dir ?? 'inout' };
  }
  if (c.kind === 'sevenseg') {
    const raw = c as import('./types.js').SevenSegComponent & { color?: string; hasDp?: boolean };
    const names =
      raw.pinOrder?.length > 0
        ? raw.pinOrder
        : raw.hasDp
          ? ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp']
          : ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const seg = {
      ...raw,
      kind: 'sevenseg' as const,
      hasDp: raw.hasDp ?? names.includes('dp'),
      color: raw.color ?? '#ff5533',
      pinOrder: names,
      rotation: raw.rotation ?? 0,
      mirrorX: raw.mirrorX ?? false,
      mirrorY: raw.mirrorY ?? false,
    };
    applyPinLayout(seg);
    return seg;
  }
  if (c.kind === 'clock') {
    const raw = c as ClockComponent & {
      mode?: ClockComponent['mode'];
      holdFrames?: number;
      lastTrig?: Level;
      rotation?: ClockComponent['rotation'];
      mirrorX?: boolean;
      mirrorY?: boolean;
      pins: { out: Pin; trig?: Pin };
    };
    const trig =
      raw.pins.trig ??
      ({
        id: `${raw.id}:trig`,
        componentId: raw.id,
        name: 'trig',
        pos: { x: raw.pos.x - 18, y: raw.pos.y },
      } satisfies Pin);
    const clock: ClockComponent = {
      id: raw.id,
      kind: 'clock',
      mode: raw.mode ?? 'continuous',
      value: raw.value,
      running: raw.running,
      periodFrames: raw.periodFrames,
      dutyFrames: raw.dutyFrames,
      phase: raw.phase,
      holdFrames: raw.holdFrames ?? 0,
      lastTrig: raw.lastTrig ?? 0,
      pos: raw.pos,
      rotation: raw.rotation ?? 0,
      mirrorX: raw.mirrorX ?? false,
      mirrorY: raw.mirrorY ?? false,
      pins: { out: raw.pins.out, trig },
    };
    applyPinLayout(clock);
    return clock;
  }
  const comp = c as Component;
  if (isOrientable(comp)) {
    const o = comp as Component & { rotation?: number; mirrorX?: boolean; mirrorY?: boolean };
    (o as { rotation: number }).rotation = o.rotation ?? 0;
    (o as { mirrorX: boolean }).mirrorX = o.mirrorX ?? false;
    (o as { mirrorY: boolean }).mirrorY = o.mirrorY ?? false;
    applyPinLayout(o);
  }
  return comp;
}

export interface SerializedCircuit {
  components: SerializedComponent[];
  wires: Wire[];
}

export interface SerializedChipDef {
  id: string;
  name: string;
  ports: string[];
  circuit: SerializedCircuit;
  revision?: number;
}

const PROJECT_FORMAT = 'z80-sim-project';
const CHIP_FORMAT = 'z80-sim-chip';

export interface SerializedProject {
  format: typeof PROJECT_FORMAT;
  version: 1;
  topCircuit: SerializedCircuit;
  chipDefs: SerializedChipDef[];
}

/** A single chip def plus every other def it (transitively) depends on — see collectDependencies(). */
export interface SerializedChipBundle {
  format: typeof CHIP_FORMAT;
  version: 1;
  rootId: string; // which entry in `defs` is "the" chip being exported
  defs: SerializedChipDef[];
}

function serializeCircuit(circuit: Circuit): SerializedCircuit {
  return {
    components: [...circuit.components.values()].map(toSerializedComponent),
    wires: [...circuit.wires.values()].map((w) =>
      w.waypoints ? { ...w, waypoints: w.waypoints.map((p) => ({ ...p })) } : { ...w },
    ),
  };
}

/** Deep-ish snapshot of a circuit for undo / clipboard restore. */
export type CircuitSnapshot = SerializedCircuit;

export function captureCircuit(circuit: Circuit): CircuitSnapshot {
  return serializeCircuit(circuit);
}

/** Replace `circuit`'s contents with a snapshot (keeps the same Circuit object). */
export function restoreCircuit(circuit: Circuit, snap: CircuitSnapshot): void {
  circuit.components.clear();
  circuit.wires.clear();
  for (const sc of snap.components) {
    const c = fromSerializedComponent(structuredClone(sc));
    circuit.addRawComponent(c);
    noteUsedId(c.id);
    for (const p of Object.values(c.pins) as Pin[]) noteUsedId(p.id);
  }
  for (const w of snap.wires) {
    circuit.addRawWire(
      w.waypoints
        ? { ...w, waypoints: w.waypoints.map((p) => ({ ...p })) }
        : { id: w.id, a: w.a, b: w.b },
    );
    noteUsedId(w.id);
  }
  bumpStructureVersion();
}

function serializeChipDefPlain(def: ChipDef): SerializedChipDef {
  return {
    id: def.id,
    name: def.name,
    ports: [...def.ports],
    circuit: serializeCircuit(def.circuit),
    ...(def.revision ? { revision: def.revision } : {}),
  };
}

// --- Whole-project export/import (replaces the running session's state) ---

export function serializeProject(topCircuit: Circuit, library: ChipLibrary): SerializedProject {
  return {
    format: PROJECT_FORMAT,
    version: 1,
    topCircuit: serializeCircuit(topCircuit),
    chipDefs: library.list().map(serializeChipDefPlain),
  };
}

function loadCircuit(data: SerializedCircuit): Circuit {
  const circuit = new Circuit();
  for (const sc of data.components) {
    const c = fromSerializedComponent(sc);
    circuit.addComponent(c);
    noteUsedId(c.id);
    for (const p of Object.values(c.pins) as Pin[]) noteUsedId(p.id);
  }
  for (const w of data.wires) {
    circuit.addRawWire(w);
    noteUsedId(w.id);
  }
  return circuit;
}

export function deserializeProject(data: SerializedProject): { topCircuit: Circuit; library: ChipLibrary } {
  if (data.format !== PROJECT_FORMAT) throw new Error('Not a project file (missing/wrong "format" field).');
  const library = new ChipLibrary();
  for (const d of data.chipDefs) {
    library.register({
      id: d.id,
      name: d.name,
      ports: [...d.ports],
      circuit: loadCircuit(d.circuit),
      ...(d.revision ? { revision: d.revision } : {}),
    });
    noteUsedId(d.id);
  }
  const topCircuit = loadCircuit(data.topCircuit);
  return { topCircuit, library };
}

// --- Single chip def export/import (merges into the running session) ---

function collectDependencies(def: ChipDef, library: ChipLibrary, seen: Map<string, ChipDef>): void {
  if (seen.has(def.id)) return;
  seen.set(def.id, def);
  for (const c of def.circuit.components.values()) {
    if (c.kind === 'chip') collectDependencies(library.get(c.defId), library, seen);
  }
}

/** Bundles `def` together with every chip def it depends on, directly or through another chip — a chip built from chips isn't usable without them. */
export function serializeChipDef(def: ChipDef, library: ChipLibrary): SerializedChipBundle {
  const deps = new Map<string, ChipDef>();
  collectDependencies(def, library, deps);
  return { format: CHIP_FORMAT, version: 1, rootId: def.id, defs: [...deps.values()].map(serializeChipDefPlain) };
}

const ID_PREFIX: Record<Component['kind'], string> = {
  transistor: 't',
  source: 'src',
  input: 'in',
  button: 'btn',
  led: 'led',
  sevenseg: '7seg',
  clock: 'clk',
  analyzer: 'la',
  busprobe: 'bus',
  tty: 'tty',
  probe: 'probe',
  label: 'lbl',
  port: 'port',
  chip: 'chip',
  ram: 'ram',
  rom: 'rom',
};

/**
 * Imports a chip bundle into `library`, giving every component and chip
 * def a *fresh* id (via nextId — never the id the bundle shipped with) so
 * it can never collide with anything already in this session, no matter
 * what that session's id counter happened to be when the bundle was
 * exported elsewhere. Returns the imported (fresh-id) def corresponding to
 * `bundle.rootId` — the chip the user actually asked to import.
 */
export function importChipDef(bundle: SerializedChipBundle, library: ChipLibrary): ChipDef {
  if (bundle.format !== CHIP_FORMAT) throw new Error('Not a chip file (missing/wrong "format" field).');

  // Assign every def in the bundle a fresh id up front, so a def whose
  // dependency appears later in the array still resolves correctly.
  const defIdMap = new Map<string, string>(); // original chipdef id -> fresh chipdef id
  for (const sd of bundle.defs) defIdMap.set(sd.id, nextId('chipdef'));

  let rootDef: ChipDef | undefined;
  for (const sd of bundle.defs) {
    const pinIdMap = new Map<string, string>(); // original pin id -> fresh pin id, scoped to this one def's circuit
    const circuit = new Circuit();

    for (const c of sd.circuit.components) {
      const newCompId = nextId(ID_PREFIX[c.kind]);
      const clone = fromSerializedComponent(structuredClone(c) as SerializedComponent);
      clone.id = newCompId;

      const originalPins = c.pins as unknown as Record<string, Pin>;
      const clonePins = clone.pins as unknown as Record<string, Pin>;
      for (const key of Object.keys(originalPins)) {
        const newPinId = `${newCompId}:${originalPins[key]!.name}`;
        pinIdMap.set(originalPins[key]!.id, newPinId);
        clonePins[key] = { ...clonePins[key]!, id: newPinId, componentId: newCompId };
      }

      if (clone.kind === 'chip') {
        const newDefId = defIdMap.get((c as ChipInstanceComponent).defId);
        if (!newDefId) throw new Error(`chip bundle is missing a dependency: ${(c as ChipInstanceComponent).defId}`);
        clone.defId = newDefId;
      }
      circuit.addComponent(clone);
    }

    for (const w of sd.circuit.wires) {
      const a = pinIdMap.get(w.a);
      const b = pinIdMap.get(w.b);
      if (!a || !b) throw new Error('chip bundle has a wire referencing an unknown pin.');
      circuit.addRawWire({ id: nextId('w'), a, b, ...(w.waypoints ? { waypoints: w.waypoints.map((p) => ({ ...p })) } : {}) });
    }

    const def: ChipDef = {
      id: defIdMap.get(sd.id)!,
      name: sd.name,
      ports: [...sd.ports],
      circuit,
      ...(sd.revision ? { revision: sd.revision } : {}),
    };
    library.register(def);
    if (sd.id === bundle.rootId) rootDef = def;
  }

  if (!rootDef) throw new Error('chip bundle is missing its own root def.');
  return rootDef;
}
