import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import type { ChipDef } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten, fold, foldExposing, renamePort } from '../src/sim/hierarchy.js';
import {
  buildNand,
  buildNot,
  makeChipInstance,
  makeInput,
  makeLabel,
  makeRam,
  makeSource,
  wire,
} from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Level, LabelComponent } from '../src/sim/types.js';

/** Run the relaxation solver on a (possibly hierarchical) circuit until it settles. */
function settle(circuit: Circuit, library: ChipLibrary) {
  const flat = flatten(circuit, library);
  const netMap = flat.computeNets();
  let state = initialState();
  for (let i = 0; i < 8 && (i === 0 || !state.settled); i++) {
    state = step(flat, netMap, state);
  }
  if (!state.settled) throw new Error('circuit did not settle');
  return { netMap, state };
}

function levelAt(state: ReturnType<typeof settle>['state'], netMap: ReturnType<typeof settle>['netMap'], pinId: string): Level {
  const net = netMap.netOf.get(pinId);
  if (!net) throw new Error(`unknown pin ${pinId}`);
  return state.levelOf.get(net) ?? 'Z';
}

function makeNandChip(library: ChipLibrary): ChipDef {
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

function makeNotChip(library: ChipLibrary): ChipDef {
  const scratch = new Circuit();
  makeSource(scratch, 1); // rail driver
  makeSource(scratch, 0);
  const notGate = buildNot(scratch);
  return foldExposing(scratch, 'NOT', library, [
    { pin: notGate.in, isOutput: false },
    { pin: notGate.out, isOutput: true },
  ], { labelize: false });
}

describe('fold + flatten a NAND into a reusable chip', () => {
  it.each([
    [0, 0, 1],
    [0, 1, 1],
    [1, 0, 1],
    [1, 1, 0],
  ] as const)('a=%i b=%i -> out=%i, same truth table as the raw gate', (a, b, out) => {
    const library = new ChipLibrary();
    const def = makeNandChip(library);
    expect(def.ports).toHaveLength(3); // a, b, out — VCC/GND never become ports, see fold()

    const parent = new Circuit();
    const inA = makeInput(parent, a);
    const inB = makeInput(parent, b);
    const inst = makeChipInstance(parent, def, { x: 100, y: 100 });
    wire(parent, inA.pins.out, inst.pins[def.ports[0]!]!);
    wire(parent, inB.pins.out, inst.pins[def.ports[1]!]!);

    const { netMap, state } = settle(parent, library);
    expect(levelAt(state, netMap, inst.pins[def.ports[2]!]!.id)).toBe(out);
  });
});

describe('nested folding: an AND chip built from a folded-NAND chip + a folded-NOT chip', () => {
  it.each([
    [0, 0, 0],
    [0, 1, 0],
    [1, 0, 0],
    [1, 1, 1],
  ] as const)('a=%i b=%i -> out=%i, two levels of hierarchy deep', (a, b, out) => {
    const library = new ChipLibrary();
    const nandDef = makeNandChip(library);
    const notDef = makeNotChip(library);

    // Compose NAND-chip + NOT-chip into an AND, then fold *that* into its
    // own chip — a chip whose internals are themselves chip instances.
    const scratch = new Circuit();
    const nandInst = makeChipInstance(scratch, nandDef, { x: 0, y: 0 });
    const notInst = makeChipInstance(scratch, notDef, { x: 100, y: 0 });
    wire(scratch, nandInst.pins[nandDef.ports[2]!]!, notInst.pins[notDef.ports[0]!]!);
    const andDef = foldExposing(scratch, 'AND', library, [
      { pin: nandInst.pins[nandDef.ports[0]!]!, isOutput: false },
      { pin: nandInst.pins[nandDef.ports[1]!]!, isOutput: false },
      { pin: notInst.pins[notDef.ports[1]!]!, isOutput: true },
    ]);
    expect(andDef.ports).toHaveLength(3);

    const parent = new Circuit();
    const inA = makeInput(parent, a);
    const inB = makeInput(parent, b);
    const inst = makeChipInstance(parent, andDef, { x: 200, y: 0 });
    wire(parent, inA.pins.out, inst.pins[andDef.ports[0]!]!);
    wire(parent, inB.pins.out, inst.pins[andDef.ports[1]!]!);

    const { netMap, state } = settle(parent, library);
    expect(levelAt(state, netMap, inst.pins[andDef.ports[2]!]!.id)).toBe(out);
  });
});

describe('two independent instances of the same chip def', () => {
  it('do not leak internal nets into each other', () => {
    const library = new ChipLibrary();
    const notDef = makeNotChip(library);

    const parent = new Circuit();
    const in1 = makeInput(parent, 0);
    const in2 = makeInput(parent, 1);
    const inst1 = makeChipInstance(parent, notDef, { x: 0, y: 0 });
    const inst2 = makeChipInstance(parent, notDef, { x: 200, y: 0 });
    wire(parent, in1.pins.out, inst1.pins[notDef.ports[0]!]!);
    wire(parent, in2.pins.out, inst2.pins[notDef.ports[0]!]!);

    const { netMap, state } = settle(parent, library);
    // Each instance carries its own local VCC/GND (see fold()'s doc comment)
    // and its own namespaced internal nets — if namespacing were broken, the
    // two instances' pull-up/pull-down nodes would short together and this
    // would report contention or the wrong level instead of these values.
    expect(levelAt(state, netMap, inst1.pins[notDef.ports[1]!]!.id)).toBe(1); // NOT(0)
    expect(levelAt(state, netMap, inst2.pins[notDef.ports[1]!]!.id)).toBe(0); // NOT(1)
    expect(state.contended.size).toBe(0);
  });
});

describe('flatten namespaces non-global labels per chip instance', () => {
  it('keeps SIG labels on separate nets while VCC/GND stay global', () => {
    const library = new ChipLibrary();
    const scratch = new Circuit();
    const vcc = makeSource(scratch, 1).pins.out;
    const gnd = makeSource(scratch, 0).pins.out;
    const nand = buildNand(scratch);
    // Named internal tie — without namespacing, two instances would short SIG.
    wire(scratch, nand.out, makeLabel(scratch, 'SIG').pins.net);
    wire(scratch, vcc, makeLabel(scratch, 'VCC').pins.net);
    wire(scratch, gnd, makeLabel(scratch, 'GND').pins.net);
    const def = foldExposing(scratch, 'SIG_CHIP', library, [
      { pin: nand.a, isOutput: false },
      { pin: nand.b, isOutput: false },
      { pin: nand.out, isOutput: true },
    ], { labelize: false });

    const parent = new Circuit();
    makeChipInstance(parent, def, { x: 0, y: 0 });
    makeChipInstance(parent, def, { x: 200, y: 0 });
    const flat = flatten(parent, library);

    const sigLabels = [...flat.components.values()].filter(
      (c): c is LabelComponent => c.kind === 'label' && c.name.includes('SIG'),
    );
    expect(sigLabels).toHaveLength(2);
    expect(sigLabels[0]!.name).not.toBe(sigLabels[1]!.name);
    expect(sigLabels[0]!.name).toContain('SIG');
    expect(sigLabels[1]!.name).toContain('SIG');

    const netMap = flat.computeNets();
    const sigNet0 = netMap.netOf.get(sigLabels[0]!.pins.net.id);
    const sigNet1 = netMap.netOf.get(sigLabels[1]!.pins.net.id);
    expect(sigNet0).toBeDefined();
    expect(sigNet1).toBeDefined();
    expect(sigNet0).not.toBe(sigNet1);

    const powerLabels = [...flat.components.values()].filter(
      (c): c is LabelComponent => c.kind === 'label' && (c.name === 'VCC' || c.name === 'GND'),
    );
    expect(powerLabels.some((c) => c.name === 'VCC')).toBe(true);
    expect(powerLabels.some((c) => c.name === 'GND')).toBe(true);
    expect(powerLabels.every((c) => c.name === 'VCC' || c.name === 'GND')).toBe(true);
  });
});

describe('renamePort', () => {
  it('propagates to every existing instance and keeps simulation working', () => {
    const library = new ChipLibrary();
    const notDef = makeNotChip(library);
    const [oldIn, oldOut] = notDef.ports as [string, string];

    const parent = new Circuit();
    const in1 = makeInput(parent, 0);
    const inst = makeChipInstance(parent, notDef, { x: 0, y: 0 });
    wire(parent, in1.pins.out, inst.pins[oldIn]!);

    const ok = renamePort(library, [parent], notDef.id, oldIn, 'IN');
    expect(ok).toBe(true);
    expect(notDef.ports[0]).toBe('IN');
    expect(inst.pins['IN']).toBeDefined();
    expect(inst.pins[oldIn]).toBeUndefined();

    // The existing wire (by pin id, never touched) still works after rename.
    const { netMap, state } = settle(parent, library);
    expect(levelAt(state, netMap, inst.pins[oldOut]!.id)).toBe(1); // NOT(0)
  });

  it('rejects a rename that collides with an existing port name', () => {
    const library = new ChipLibrary();
    const nandDef = makeNandChip(library);
    const [a, b] = nandDef.ports as [string, string, string];
    expect(renamePort(library, [], nandDef.id, b, a)).toBe(false);
    expect(nandDef.ports).toEqual([a, b, nandDef.ports[2]]);
  });
});

describe('fold() refuses to fold a RAM component', () => {
  it('throws rather than silently making every instance share one Uint8Array', () => {
    const library = new ChipLibrary();
    const parent = new Circuit();
    const ram = makeRam(parent, 2, 8);
    expect(() => fold(parent, new Set([ram.id]), 'RAM_CHIP', library, { x: 0, y: 0 })).toThrow(/RAM/);
  });
});
