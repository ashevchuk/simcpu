import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import type { ChipDef } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { makeChipInstance, makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import { pruneDuplicateChipNames, seedStandardCells } from '../src/sim/stdcells.js';
import type { Level, NetMap, SimState } from '../src/sim/types.js';

function tick(circuit: Circuit, netMap: NetMap, state: SimState, n = 10): SimState {
  for (let i = 0; i < n; i++) state = step(circuit, netMap, state);
  return state;
}

function levelAt(state: SimState, netMap: NetMap, pinId: string): Level {
  const net = netMap.netOf.get(pinId);
  if (!net) throw new Error(`unknown pin ${pinId}`);
  return state.levelOf.get(net) ?? 'Z';
}

function getDef(library: ChipLibrary, name: string): ChipDef {
  const def = library.list().find((d) => d.name === name);
  if (!def) throw new Error(`${name} was not seeded`);
  return def;
}

/**
 * These re-check the fold wiring itself (exposedPins order matching each
 * builder's actual pin roles), not the underlying gate logic — that's
 * already exhaustively covered where each builder is defined
 * (solver.test.ts, sequential.test.ts). A sample spanning different port
 * counts and shapes (2-port, mixed in/out, sequential) is enough to catch
 * an exposedPins ordering mistake, which is the one new way to get this
 * wrong here.
 */
describe('seedStandardCells — placed chip instances behave like the raw gates they wrap', () => {
  it('is idempotent by name (session reload must not duplicate Library entries)', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const once = library.list().length;
    seedStandardCells(library);
    seedStandardCells(library);
    expect(library.list().length).toBe(once);
    const names = library.list().map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });
  it('NOT', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const def = getDef(library, 'NOT');
    const parent = new Circuit();
    const inst = makeChipInstance(parent, def);
    const input = makeInput(parent, 0);
    wire(parent, input.pins.out, inst.pins[def.ports[0]!]!);

    const flat = flatten(parent, library);
    const netMap = flat.computeNets();
    const state = tick(flat, netMap, initialState());
    expect(levelAt(state, netMap, inst.pins[def.ports[1]!]!.id)).toBe(1);
  });

  it('XOR', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const def = getDef(library, 'XOR');
    const parent = new Circuit();
    const inst = makeChipInstance(parent, def);
    const a = makeInput(parent, 1);
    const b = makeInput(parent, 1);
    wire(parent, a.pins.out, inst.pins[def.ports[0]!]!);
    wire(parent, b.pins.out, inst.pins[def.ports[1]!]!);

    const flat = flatten(parent, library);
    const netMap = flat.computeNets();
    const state = tick(flat, netMap, initialState());
    expect(levelAt(state, netMap, inst.pins[def.ports[2]!]!.id)).toBe(0); // 1 xor 1 = 0
  });

  it('HALF_ADDER', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const def = getDef(library, 'HALF_ADDER');
    const parent = new Circuit();
    const inst = makeChipInstance(parent, def);
    const a = makeInput(parent, 1);
    const b = makeInput(parent, 1);
    wire(parent, a.pins.out, inst.pins[def.ports[0]!]!);
    wire(parent, b.pins.out, inst.pins[def.ports[1]!]!);

    const flat = flatten(parent, library);
    const netMap = flat.computeNets();
    const state = tick(flat, netMap, initialState());
    expect(levelAt(state, netMap, inst.pins[def.ports[2]!]!.id)).toBe(0); // sum(1,1) = 0
    expect(levelAt(state, netMap, inst.pins[def.ports[3]!]!.id)).toBe(1); // cout(1,1) = 1

    a.value = 0;
    b.value = 1;
    const flat2 = flatten(parent, library);
    const netMap2 = flat2.computeNets();
    const state2 = tick(flat2, netMap2, initialState());
    expect(levelAt(state2, netMap2, inst.pins[def.ports[2]!]!.id)).toBe(1); // sum(0,1) = 1
    expect(levelAt(state2, netMap2, inst.pins[def.ports[3]!]!.id)).toBe(0); // cout(0,1) = 0
  });

  it('MUX2', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const def = getDef(library, 'MUX2');
    const parent = new Circuit();
    const inst = makeChipInstance(parent, def);
    const sel = makeInput(parent, 1);
    const in0 = makeInput(parent, 0);
    const in1 = makeInput(parent, 1);
    wire(parent, sel.pins.out, inst.pins[def.ports[0]!]!);
    wire(parent, in0.pins.out, inst.pins[def.ports[1]!]!);
    wire(parent, in1.pins.out, inst.pins[def.ports[2]!]!);

    const flat = flatten(parent, library);
    const netMap = flat.computeNets();
    const state = tick(flat, netMap, initialState());
    expect(levelAt(state, netMap, inst.pins[def.ports[3]!]!.id)).toBe(1); // sel=1 -> in1
  });

  it('FULL_ADDER', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const def = getDef(library, 'FULL_ADDER');
    const parent = new Circuit();
    const inst = makeChipInstance(parent, def);
    const a = makeInput(parent, 1);
    const b = makeInput(parent, 1);
    const cin = makeInput(parent, 1);
    wire(parent, a.pins.out, inst.pins[def.ports[0]!]!);
    wire(parent, b.pins.out, inst.pins[def.ports[1]!]!);
    wire(parent, cin.pins.out, inst.pins[def.ports[2]!]!);

    const flat = flatten(parent, library);
    const netMap = flat.computeNets();
    const state = tick(flat, netMap, initialState());
    expect(levelAt(state, netMap, inst.pins[def.ports[3]!]!.id)).toBe(1); // sum(1,1,1) = 1
    expect(levelAt(state, netMap, inst.pins[def.ports[4]!]!.id)).toBe(1); // cout(1,1,1) = 1
  });

  it('TRI_BUF', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const def = getDef(library, 'TRI_BUF');
    const parent = new Circuit();
    const inst = makeChipInstance(parent, def);
    const a = makeInput(parent, 1);
    const en = makeInput(parent, 0);
    wire(parent, a.pins.out, inst.pins[def.ports[0]!]!);
    wire(parent, en.pins.out, inst.pins[def.ports[1]!]!);

    const flat = flatten(parent, library);
    const netMap = flat.computeNets();
    const state = tick(flat, netMap, initialState());
    expect(levelAt(state, netMap, inst.pins[def.ports[2]!]!.id)).toBe('Z'); // en=0: floats, regardless of a
  });

  it('D_FF captures D only on the CLK 0->1 edge', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const def = getDef(library, 'D_FF');
    const parent = new Circuit();
    const inst = makeChipInstance(parent, def);
    const d = makeInput(parent, 1);
    const clk = makeInput(parent, 0);
    wire(parent, d.pins.out, inst.pins[def.ports[0]!]!);
    wire(parent, clk.pins.out, inst.pins[def.ports[1]!]!);

    let state = initialState();
    let netMap: NetMap;
    const hop = () => {
      const flat = flatten(parent, library);
      netMap = flat.computeNets();
      state = tick(flat, netMap, state);
    };

    hop(); // CLK=0, D=1: master tracks, slave not asserted yet
    clk.value = 1;
    hop(); // rising edge captures D=1
    expect(levelAt(state, netMap!, inst.pins[def.ports[2]!]!.id)).toBe(1);
  });
});

describe('pruneDuplicateChipNames', () => {
  it('removes unreferenced same-name orphans left by re-seeding', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const not = library.findByName('NOT')!;
    // Simulate the old bug: register a second NOT with a different id.
    library.register({
      id: 'orphan-not',
      name: 'NOT',
      ports: [...not.ports],
      circuit: new Circuit(),
    });
    expect(library.list().filter((d) => d.name === 'NOT').length).toBe(2);

    const parent = new Circuit();
    makeChipInstance(parent, not);
    const removed = pruneDuplicateChipNames(library, [parent, ...library.list().map((d) => d.circuit)]);
    expect(removed).toBe(1);
    expect(library.list().filter((d) => d.name === 'NOT').length).toBe(1);
    expect(library.has(not.id)).toBe(true);
  });
});
