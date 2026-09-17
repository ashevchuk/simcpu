import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit, nextId } from '../src/sim/Circuit.js';
import { flatten, fold, foldExposing } from '../src/sim/hierarchy.js';
import { buildNand, buildNot, makeChipInstance, makeInput, makeRam, makeSource, wire } from '../src/sim/library.js';
import {
  deserializeProject,
  importChipDef,
  serializeChipDef,
  serializeProject,
  type SerializedChipBundle,
  type SerializedProject,
} from '../src/sim/serialize.js';
import { initialState, step } from '../src/sim/solver.js';
import { seedStandardCells } from '../src/sim/stdcells.js';
import type { Level } from '../src/sim/types.js';

function levelAt(circuit: Circuit, library: ChipLibrary, pinId: string): Level {
  const flat = flatten(circuit, library);
  const netMap = flat.computeNets();
  const state = step(flat, netMap, initialState());
  const net = netMap.netOf.get(pinId);
  if (!net) throw new Error(`unknown pin ${pinId}`);
  return state.levelOf.get(net) ?? 'Z';
}

function makeNandChip(library: ChipLibrary) {
  const scratch = new Circuit();
  const vcc = makeSource(scratch, 1).pins.out;
  const gnd = makeSource(scratch, 0).pins.out;
  const nand = buildNand(scratch);
  return foldExposing(scratch, 'NAND', library, [
    { pin: nand.a, isOutput: false },
    { pin: nand.b, isOutput: false },
    { pin: nand.out, isOutput: true },
  ], { labelize: false });
}

function makeNotChip(library: ChipLibrary) {
  const scratch = new Circuit();
  makeSource(scratch, 1); // rail driver
  makeSource(scratch, 0);
  const notGate = buildNot(scratch);
  return foldExposing(scratch, 'NOT', library, [
    { pin: notGate.in, isOutput: false },
    { pin: notGate.out, isOutput: true },
  ], { labelize: false });
}

describe('project serialize/deserialize round-trip', () => {
  it('preserves a working circuit, including a folded chip instance', () => {
    const library = new ChipLibrary();
    const nandDef = makeNandChip(library);
    const topCircuit = new Circuit();
    const inA = makeInput(topCircuit, 1);
    const inB = makeInput(topCircuit, 1);
    const inst = makeChipInstance(topCircuit, nandDef);
    wire(topCircuit, inA.pins.out, inst.pins[nandDef.ports[0]!]!);
    wire(topCircuit, inB.pins.out, inst.pins[nandDef.ports[1]!]!);

    const json = JSON.stringify(serializeProject(topCircuit, library));
    const loaded = deserializeProject(JSON.parse(json) as SerializedProject);

    const loadedInst = [...loaded.topCircuit.components.values()].find((c) => c.kind === 'chip')!;
    expect(levelAt(loaded.topCircuit, loaded.library, loadedInst.pins[nandDef.ports[2]!]!.id)).toBe(0); // NAND(1,1)=0
  });

  it('round-trips a RAM component as a real Uint8Array, not the plain object JSON.stringify would turn it into', () => {
    const library = new ChipLibrary();
    const topCircuit = new Circuit();
    const ram = makeRam(topCircuit, 2, 8, Uint8Array.of(0x4d, 0x00, 0xff, 0x0f));

    const json = JSON.stringify(serializeProject(topCircuit, library));
    // A naive JSON.stringify of a Uint8Array produces {"0":77,"1":0,...} — no
    // real array at all — so this must not appear literally in the output.
    expect(json).not.toContain('"0":77');

    const loaded = deserializeProject(JSON.parse(json) as SerializedProject);
    const loadedRam = [...loaded.topCircuit.components.values()].find((c) => c.kind === 'ram');
    expect(loadedRam?.kind).toBe('ram');
    if (loadedRam?.kind !== 'ram') throw new Error('unreachable');
    expect(loadedRam.bytes).toBeInstanceOf(Uint8Array);
    expect(loadedRam.bytes).toEqual(ram.bytes);
    expect(loadedRam.bytes.length).toBe(4); // 2 ** addrBits, not left as `undefined` off a plain object
  });

  it('rejects a file with the wrong format tag', () => {
    expect(() => deserializeProject({ format: 'nope', version: 1, topCircuit: { components: [], wires: [] }, chipDefs: [] } as unknown as SerializedProject)).toThrow();
  });

  it('advances the id counter past everything it loads, so new components never collide', () => {
    const topCircuit = new Circuit();
    // Simulate a project saved by a session whose counter had run way ahead.
    const highId = 'src999999';
    topCircuit.components.set(highId, {
      id: highId,
      kind: 'source',
      value: 1,
      pos: { x: 0, y: 0 },
      rotation: 0,
      mirrorX: false,
      mirrorY: false,
      pins: { out: { id: `${highId}:out`, componentId: highId, name: 'out', pos: { x: 0, y: 0 } } },
    });
    const project: SerializedProject = {
      format: 'z80-sim-project',
      version: 1,
      // Cast is safe: this fixture is a plain SourceComponent, not RamComponent
      // (the one Component variant SerializedCircuit's type doesn't accept as-is —
      // see serialize.ts's file header for why).
      topCircuit: { components: [...topCircuit.components.values()] as SerializedProject['topCircuit']['components'], wires: [] },
      chipDefs: [],
    };

    deserializeProject(project);
    const freshId = nextId('src');
    const freshNumber = Number(/(\d+)$/.exec(freshId)![1]);
    expect(freshNumber).toBeGreaterThan(999999);
  });
});

describe('single chip def export/import', () => {
  it('bundles a chip built from other chips together with its dependencies', () => {
    const library = new ChipLibrary();
    const nandDef = makeNandChip(library);
    const notDef = makeNotChip(library);

    const scratch = new Circuit();
    const nandInst = makeChipInstance(scratch, nandDef);
    const notInst = makeChipInstance(scratch, notDef);
    wire(scratch, nandInst.pins[nandDef.ports[2]!]!, notInst.pins[notDef.ports[0]!]!);
    const { def: andDef } = fold(scratch, new Set(scratch.components.keys()), 'AND', library, { x: 0, y: 0 });

    const bundle = serializeChipDef(andDef, library);
    const names = bundle.defs.map((d) => d.name).sort();
    expect(names).toEqual(['AND', 'NAND', 'NOT']);
  });

  it('imports into a fresh library with new ids and still simulates correctly', () => {
    const sourceLibrary = new ChipLibrary();
    const notDef = makeNotChip(sourceLibrary);
    const bundle = JSON.parse(JSON.stringify(serializeChipDef(notDef, sourceLibrary))) as SerializedChipBundle;

    const targetLibrary = new ChipLibrary();
    const imported = importChipDef(bundle, targetLibrary);
    expect(imported.id).not.toBe(notDef.id); // fresh id, not the original session's

    const topCircuit = new Circuit();
    const input = makeInput(topCircuit, 0);
    const inst = makeChipInstance(topCircuit, imported);
    wire(topCircuit, input.pins.out, inst.pins[imported.ports[0]!]!);
    expect(levelAt(topCircuit, targetLibrary, inst.pins[imported.ports[1]!]!.id)).toBe(1); // NOT(0) = 1
  });

  it("never reuses any of the bundle's original ids — every component in the imported def is freshly numbered", () => {
    const sourceLibrary = new ChipLibrary();
    const notDef = makeNotChip(sourceLibrary);
    const bundle = JSON.parse(JSON.stringify(serializeChipDef(notDef, sourceLibrary))) as SerializedChipBundle;
    const originalIds = new Set(bundle.defs.flatMap((d) => d.circuit.components.map((c) => c.id)));

    const imported = importChipDef(bundle, new ChipLibrary());

    for (const id of imported.circuit.components.keys()) expect(originalIds.has(id)).toBe(false);
  });
});

describe('deserializeProject isolates bundled example JSON', () => {
  it('does not mutate EXAMPLE_PROJECTS when the live circuit is edited', async () => {
    const { EXAMPLE_PROJECTS } = await import('../src/examples/catalog.js');
    const latch = EXAMPLE_PROJECTS.find((e) => e.id === 'd-latch');
    expect(latch).toBeTruthy();
    const origX = latch!.project.topCircuit.components[0]!.pos.x;

    const loaded = deserializeProject(latch!.project);
    for (const c of loaded.topCircuit.components.values()) c.pos.x += 500;

    expect(latch!.project.topCircuit.components[0]!.pos.x).toBe(origX);

    const again = deserializeProject(latch!.project);
    const first = [...again.topCircuit.components.values()][0]!;
    expect(first.pos.x).toBe(origX);
  });

  it('switches between examples without aliasing component maps', async () => {
    const { EXAMPLE_PROJECTS } = await import('../src/examples/catalog.js');
    const latch = EXAMPLE_PROJECTS.find((e) => e.id === 'd-latch')!;
    const counter = EXAMPLE_PROJECTS.find((e) => e.id === 'lab-counter-7seg')!;
    const a = deserializeProject(latch.project);
    const b = deserializeProject(counter.project);
    expect(a.topCircuit.components.size).not.toBe(b.topCircuit.components.size);
    expect([...a.topCircuit.components.keys()][0]).not.toBe([...b.topCircuit.components.keys()][0]);
  });
});

describe('softState.q JSON round-trip', () => {
  it('restores Uint8Array q after JSON.stringify (autosave path)', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const def = library.findByName('COUNTER4');
    expect(def).toBeTruthy();
    const circuit = new Circuit();
    const chip = makeChipInstance(circuit, def!, { x: 0, y: 0 });
    chip.softState = { model: 'COUNTER4', lastClk: 0, q: new Uint8Array([1, 0, 1, 1]) };
    const json = JSON.parse(JSON.stringify(serializeProject(circuit, library))) as SerializedProject;
    // Corrupted shape before the fix: softState.q became {"0":1,"1":0,...}.
    const loaded = deserializeProject(json);
    const again = [...loaded.topCircuit.components.values()].find((c) => c.kind === 'chip');
    expect(again?.kind).toBe('chip');
    if (again?.kind !== 'chip') return;
    expect(again.softState?.q).toBeInstanceOf(Uint8Array);
    expect(Array.from(again.softState!.q)).toEqual([1, 0, 1, 1]);
    expect([...again.softState!.q].join('')).toBe('1011');
  });
});
