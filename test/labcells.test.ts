import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import type { ChipDef } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { LABCELL_NAMES, isLabcellName, seedLabCells } from '../src/sim/labcells.js';
import { makeChipInstance, makeInput, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import { isStdcellName, seedStandardCells } from '../src/sim/stdcells.js';
import type { Level, NetMap, SimState } from '../src/sim/types.js';

function tick(circuit: Circuit, netMap: NetMap, state: SimState, n = 24): SimState {
  for (let i = 0; i < n; i++) state = step(circuit, netMap, state);
  return state;
}

function levelAt(state: SimState, netMap: NetMap, pinId: string): Level {
  const net = netMap.netOf.get(pinId);
  if (!net) throw new Error(`unknown pin ${pinId}`);
  return state.levelOf.get(net) ?? 'Z';
}

function getDef(library: ChipLibrary, name: string): ChipDef {
  const def = library.findByName(name);
  if (!def) throw new Error(`${name} was not seeded`);
  return def;
}

function risingEdge(
  parent: Circuit,
  library: ChipLibrary,
  clk: { value: 0 | 1 },
  state: SimState,
): { state: SimState; netMap: NetMap } {
  let s = state;
  let netMap!: NetMap;
  const hop = () => {
    const flat = flatten(parent, library);
    netMap = flat.computeNets();
    s = tick(flat, netMap, s);
  };
  clk.value = 0;
  hop();
  clk.value = 1;
  hop();
  return { state: s, netMap };
}

describe('seedLabCells', () => {
  it('is idempotent by name when called via seedStandardCells', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const once = library.list().length;
    seedStandardCells(library);
    seedLabCells(library);
    expect(library.list().length).toBe(once);
    const names = library.list().map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('seeds expected Pack A/B names and tags them as stdcells', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    for (const name of [
      'SR_LATCH',
      'JK_FF',
      'T_FF',
      'REG4',
      'REG8',
      'SHIFT4_SIPO',
      'SHIFT8_SIPO',
      'SHIFT4_PISO',
      'SHIFT8_PISO',
      'COUNTER4',
      'DECODER_2_4',
      'DECODER_3_8',
      'ENCODER_8_3',
      'COMP2',
      'COMP4',
      'BCD_7SEG',
      'BUF8',
      'INV8',
      'LATCH8',
      'MUX8_1',
      'DEMUX_1_8',
      'SIPO8',
      'PISO8',
      'CLK_DIV2',
      'CLK_DIV16',
      '7400',
      '7474',
      '74161',
      '7447',
    ]) {
      expect(library.findByName(name), name).toBeTruthy();
      expect(isLabcellName(name)).toBe(true);
      expect(isStdcellName(name)).toBe(true);
      expect(LABCELL_NAMES.has(name)).toBe(true);
    }
  });


  it('T_FF toggles when t=1', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const def = getDef(library, 'T_FF');
    const parent = new Circuit();
    const inst = makeChipInstance(parent, def);
    const t = makeInput(parent, 1);
    const clr = makeInput(parent, 1);
    const clk = makeInput(parent, 0);
    wire(parent, t.pins.out, inst.pins.t!);
    wire(parent, clr.pins.out, inst.pins.clr!);
    wire(parent, clk.pins.out, inst.pins.clk!);
    let state = initialState();
    let netMap!: NetMap;
    const edge = () => {
      const r = risingEdge(parent, library, clk, state);
      state = r.state;
      netMap = r.netMap;
    };
    edge(); // sync clear → q=0
    expect(levelAt(state, netMap, inst.pins.q!.id)).toBe(0);
    clr.value = 0;
    edge();
    expect(levelAt(state, netMap, inst.pins.q!.id)).toBe(1);
    edge();
    expect(levelAt(state, netMap, inst.pins.q!.id)).toBe(0);
  });

  it('COUNTER4 toggles through a binary sequence', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const def = getDef(library, 'COUNTER4');
    const parent = new Circuit();
    const inst = makeChipInstance(parent, def);
    const clr = makeInput(parent, 1);
    const clk = makeInput(parent, 0);
    wire(parent, clr.pins.out, inst.pins.clr!);
    wire(parent, clk.pins.out, inst.pins.clk!);

    let state = initialState();
    let netMap!: NetMap;
    const readQ = (): number => {
      let v = 0;
      for (let i = 0; i < 4; i++) {
        if (levelAt(state, netMap, inst.pins[`q${i}`]!.id) === 1) v |= 1 << i;
      }
      return v;
    };

    const edge = () => {
      const r = risingEdge(parent, library, clk, state);
      state = r.state;
      netMap = r.netMap;
    };

    edge(); // sync clear → 0
    expect(readQ()).toBe(0);
    clr.value = 0;
    for (let i = 0; i < 4; i++) {
      const before = readQ();
      edge();
      expect(readQ()).toBe((before + 1) & 0xf);
    }
  });

  it('SHIFT4_SIPO shifts a 1 through the chain', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const def = getDef(library, 'SHIFT4_SIPO');
    const parent = new Circuit();
    const inst = makeChipInstance(parent, def);
    const sin = makeInput(parent, 1);
    const clk = makeInput(parent, 0);
    wire(parent, sin.pins.out, inst.pins.sin!);
    wire(parent, clk.pins.out, inst.pins.clk!);

    let state = initialState();
    let netMap!: NetMap;
    const edge = () => {
      const r = risingEdge(parent, library, clk, state);
      state = r.state;
      netMap = r.netMap;
    };

    edge(); // q0 <- 1
    expect(levelAt(state, netMap, inst.pins.q0!.id)).toBe(1);
    sin.value = 0;
    edge(); // q0=0, q1=1
    expect(levelAt(state, netMap, inst.pins.q0!.id)).toBe(0);
    expect(levelAt(state, netMap, inst.pins.q1!.id)).toBe(1);
    edge();
    expect(levelAt(state, netMap, inst.pins.q2!.id)).toBe(1);
  });

  it('DECODER_2_4 is one-hot', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const def = getDef(library, 'DECODER_2_4');
    const parent = new Circuit();
    const inst = makeChipInstance(parent, def);
    const a0 = makeInput(parent, 1);
    const a1 = makeInput(parent, 0);
    wire(parent, a0.pins.out, inst.pins.a0!);
    wire(parent, a1.pins.out, inst.pins.a1!);

    const flat = flatten(parent, library);
    const netMap = flat.computeNets();
    const state = tick(flat, netMap, initialState());
    // addr=01b → y1
    expect(levelAt(state, netMap, inst.pins.y0!.id)).toBe(0);
    expect(levelAt(state, netMap, inst.pins.y1!.id)).toBe(1);
    expect(levelAt(state, netMap, inst.pins.y2!.id)).toBe(0);
    expect(levelAt(state, netMap, inst.pins.y3!.id)).toBe(0);
  });

  it('REG4 loads on we+clk', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const def = getDef(library, 'REG4');
    const parent = new Circuit();
    const inst = makeChipInstance(parent, def);
    const we = makeInput(parent, 1);
    const clk = makeInput(parent, 0);
    const d = [1, 0, 1, 0].map((v) => makeInput(parent, v as 0 | 1));
    wire(parent, we.pins.out, inst.pins.we!);
    wire(parent, clk.pins.out, inst.pins.clk!);
    for (let i = 0; i < 4; i++) wire(parent, d[i]!.pins.out, inst.pins[`d${i}`]!);

    let state = initialState();
    let netMap!: NetMap;
    const r = risingEdge(parent, library, clk, state);
    state = r.state;
    netMap = r.netMap;
    expect(levelAt(state, netMap, inst.pins.q0!.id)).toBe(1);
    expect(levelAt(state, netMap, inst.pins.q1!.id)).toBe(0);
    expect(levelAt(state, netMap, inst.pins.q2!.id)).toBe(1);
    expect(levelAt(state, netMap, inst.pins.q3!.id)).toBe(0);

    // Hold when we=0
    we.value = 0;
    d[0]!.value = 0;
    const r2 = risingEdge(parent, library, clk, state);
    state = r2.state;
    netMap = r2.netMap;
    expect(levelAt(state, netMap, inst.pins.q0!.id)).toBe(1);
  });

  it('BCD_7SEG digit 0 lights a..f (not g)', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const def = getDef(library, 'BCD_7SEG');
    const parent = new Circuit();
    const inst = makeChipInstance(parent, def);
    for (let i = 0; i < 4; i++) {
      const inp = makeInput(parent, 0);
      wire(parent, inp.pins.out, inst.pins[`d${i}`]!);
    }
    const flat = flatten(parent, library);
    const netMap = flat.computeNets();
    const state = tick(flat, netMap, initialState(), 20);
    for (const seg of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
      expect(levelAt(state, netMap, inst.pins[seg]!.id), seg).toBe(1);
    }
    expect(levelAt(state, netMap, inst.pins.g!.id)).toBe(0);
  });
});
