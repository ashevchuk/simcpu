/**
 * Soft Lab ↔ transistor parity: same stimulus vectors, Soft Lab on vs off.
 */
import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import type { ChipDef } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { makeChipInstance, makeInput, wire } from '../src/sim/library.js';
import { isSoftLabEnabled, setSoftLabEnabled } from '../src/sim/softLab.js';
import { initialState, step } from '../src/sim/solver.js';
import { seedStandardCells } from '../src/sim/stdcells.js';
import type { Level, NetMap, SimState } from '../src/sim/types.js';

function tick(circuit: Circuit, netMap: NetMap, state: SimState, n = 32): SimState {
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
  settle = 32,
): { state: SimState; netMap: NetMap } {
  let s = state;
  let netMap!: NetMap;
  const hop = () => {
    const flat = flatten(parent, library);
    netMap = flat.computeNets();
    s = tick(flat, netMap, s, settle);
  };
  clk.value = 0;
  hop();
  clk.value = 1;
  hop();
  return { state: s, netMap };
}

function withSoftMode<T>(on: boolean, fn: () => T): T {
  const prev = isSoftLabEnabled();
  setSoftLabEnabled(on);
  try {
    return fn();
  } finally {
    setSoftLabEnabled(prev);
  }
}

function readPins(
  state: SimState,
  netMap: NetMap,
  inst: ReturnType<typeof makeChipInstance>,
  names: string[],
): Record<string, Level> {
  const out: Record<string, Level> = {};
  for (const n of names) out[n] = levelAt(state, netMap, inst.pins[n]!.id);
  return out;
}

describe('Soft Lab ↔ transistor parity', () => {
  it('COUNTER4 matches after clear + count edges', () => {
    const run = (soft: boolean) =>
      withSoftMode(soft, () => {
        const library = new ChipLibrary();
        seedStandardCells(library);
        const parent = new Circuit();
        const inst = makeChipInstance(parent, getDef(library, 'COUNTER4'));
        const clr = makeInput(parent, 1);
        const ce = makeInput(parent, 1);
        const load = makeInput(parent, 0);
        const clk = makeInput(parent, 0);
        wire(parent, clr.pins.out, inst.pins.clr!);
        wire(parent, ce.pins.out, inst.pins.ce!);
        wire(parent, load.pins.out, inst.pins.load!);
        wire(parent, clk.pins.out, inst.pins.clk!);
        for (let i = 0; i < 4; i++) wire(parent, makeInput(parent, 0).pins.out, inst.pins[`d${i}`]!);

        let state = initialState();
        let netMap!: NetMap;
        const edge = () => {
          const r = risingEdge(parent, library, clk, state, soft ? 8 : 48);
          state = r.state;
          netMap = r.netMap;
        };
        edge();
        clr.value = 0;
        for (let i = 0; i < 5; i++) edge();
        return readPins(state, netMap, inst, ['q0', 'q1', 'q2', 'q3', 'co']);
      });

    expect(run(true)).toEqual(run(false));
  });

  it('REG4 matches after we+clk load', () => {
    const run = (soft: boolean) =>
      withSoftMode(soft, () => {
        const library = new ChipLibrary();
        seedStandardCells(library);
        const parent = new Circuit();
        const inst = makeChipInstance(parent, getDef(library, 'REG4'));
        const we = makeInput(parent, 1);
        const clk = makeInput(parent, 0);
        const d = [1, 0, 1, 0].map((v) => makeInput(parent, v as 0 | 1));
        wire(parent, we.pins.out, inst.pins.we!);
        wire(parent, clk.pins.out, inst.pins.clk!);
        for (let i = 0; i < 4; i++) wire(parent, d[i]!.pins.out, inst.pins[`d${i}`]!);
        let state = initialState();
        const r = risingEdge(parent, library, clk, state, soft ? 8 : 40);
        return readPins(r.state, r.netMap, inst, ['q0', 'q1', 'q2', 'q3']);
      });
    expect(run(true)).toEqual(run(false));
  });

  it('SHIFT4_SIPO matches after shift edges', () => {
    const run = (soft: boolean) =>
      withSoftMode(soft, () => {
        const library = new ChipLibrary();
        seedStandardCells(library);
        const parent = new Circuit();
        const inst = makeChipInstance(parent, getDef(library, 'SHIFT4_SIPO'));
        const sin = makeInput(parent, 0);
        const clk = makeInput(parent, 0);
        wire(parent, sin.pins.out, inst.pins.sin!);
        wire(parent, clk.pins.out, inst.pins.clk!);
        let state = initialState();
        let netMap!: NetMap;
        const edge = () => {
          const r = risingEdge(parent, library, clk, state, soft ? 8 : 40);
          state = r.state;
          netMap = r.netMap;
        };
        // Flush power-up Z on transistor FFs so Soft (q=0) and gates agree.
        for (let i = 0; i < 4; i++) edge();
        sin.value = 1;
        edge();
        sin.value = 0;
        edge();
        edge();
        return readPins(state, netMap, inst, ['q0', 'q1', 'q2', 'q3']);
      });
    expect(run(true)).toEqual(run(false));
  });

  it('BCD_7SEG digit0 matches', () => {
    const run = (soft: boolean) =>
      withSoftMode(soft, () => {
        const library = new ChipLibrary();
        seedStandardCells(library);
        const parent = new Circuit();
        const inst = makeChipInstance(parent, getDef(library, 'BCD_7SEG'));
        for (let i = 0; i < 4; i++) wire(parent, makeInput(parent, 0).pins.out, inst.pins[`d${i}`]!);
        const flat = flatten(parent, library);
        const netMap = flat.computeNets();
        const state = tick(flat, netMap, initialState(), soft ? 8 : 24);
        return readPins(state, netMap, inst, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
      });
    expect(run(true)).toEqual(run(false));
  });

  it('COMP2 matches', () => {
    const run = (soft: boolean) =>
      withSoftMode(soft, () => {
        const library = new ChipLibrary();
        seedStandardCells(library);
        const parent = new Circuit();
        const inst = makeChipInstance(parent, getDef(library, 'COMP2'));
        wire(parent, makeInput(parent, 1).pins.out, inst.pins.a0!);
        wire(parent, makeInput(parent, 0).pins.out, inst.pins.a1!);
        wire(parent, makeInput(parent, 0).pins.out, inst.pins.b0!);
        wire(parent, makeInput(parent, 0).pins.out, inst.pins.b1!);
        const flat = flatten(parent, library);
        const netMap = flat.computeNets();
        const state = tick(flat, netMap, initialState(), soft ? 8 : 24);
        return readPins(state, netMap, inst, ['eq', 'gt', 'lt']);
      });
    expect(run(true)).toEqual(run(false));
  });

  it('DECODER_2_4 matches with en=1', () => {
    const run = (soft: boolean) =>
      withSoftMode(soft, () => {
        const library = new ChipLibrary();
        seedStandardCells(library);
        const parent = new Circuit();
        const inst = makeChipInstance(parent, getDef(library, 'DECODER_2_4'));
        wire(parent, makeInput(parent, 1).pins.out, inst.pins.a0!);
        wire(parent, makeInput(parent, 0).pins.out, inst.pins.a1!);
        wire(parent, makeInput(parent, 1).pins.out, inst.pins.en!);
        const flat = flatten(parent, library);
        const netMap = flat.computeNets();
        const state = tick(flat, netMap, initialState(), soft ? 8 : 24);
        return readPins(state, netMap, inst, ['y0', 'y1', 'y2', 'y3']);
      });
    expect(run(true)).toEqual(run(false));
  });

  it('COUNTER4 load+co matches', () => {
    const run = (soft: boolean) =>
      withSoftMode(soft, () => {
        const library = new ChipLibrary();
        seedStandardCells(library);
        const parent = new Circuit();
        const inst = makeChipInstance(parent, getDef(library, 'COUNTER4'));
        const clr = makeInput(parent, 1);
        const ce = makeInput(parent, 1);
        const load = makeInput(parent, 0);
        const clk = makeInput(parent, 0);
        const d = [1, 1, 0, 1].map((v) => makeInput(parent, v as 0 | 1)); // 0b1011 = 11
        wire(parent, clr.pins.out, inst.pins.clr!);
        wire(parent, ce.pins.out, inst.pins.ce!);
        wire(parent, load.pins.out, inst.pins.load!);
        wire(parent, clk.pins.out, inst.pins.clk!);
        for (let i = 0; i < 4; i++) wire(parent, d[i]!.pins.out, inst.pins[`d${i}`]!);
        let state = initialState();
        let netMap!: NetMap;
        const edge = () => {
          const r = risingEdge(parent, library, clk, state, soft ? 8 : 64);
          state = r.state;
          netMap = r.netMap;
        };
        edge(); // sync clear → 0
        clr.value = 0;
        load.value = 1;
        edge(); // parallel load 11
        load.value = 0;
        for (let i = 0; i < 4; i++) edge(); // 11→15, co asserts
        return readPins(state, netMap, inst, ['q0', 'q1', 'q2', 'q3', 'co']);
      });
    expect(run(true)).toEqual(run(false));
  });

  it('BUF8 oe matches', () => {
    const run = (soft: boolean) =>
      withSoftMode(soft, () => {
        const library = new ChipLibrary();
        seedStandardCells(library);
        const parent = new Circuit();
        const inst = makeChipInstance(parent, getDef(library, 'BUF8'));
        const oe = makeInput(parent, 1);
        wire(parent, oe.pins.out, inst.pins.oe!);
        for (let i = 0; i < 8; i++) {
          wire(parent, makeInput(parent, (i % 2) as 0 | 1).pins.out, inst.pins[`in${i}`]!);
        }
        const flat = flatten(parent, library);
        const netMap = flat.computeNets();
        const state = tick(flat, netMap, initialState(), soft ? 8 : 32);
        return readPins(
          state,
          netMap,
          inst,
          Array.from({ length: 8 }, (_, i) => `out${i}`),
        );
      });
    expect(run(true)).toEqual(run(false));
  });

  it('ADDER4 matches', () => {
    const run = (soft: boolean) =>
      withSoftMode(soft, () => {
        const library = new ChipLibrary();
        seedStandardCells(library);
        const parent = new Circuit();
        const inst = makeChipInstance(parent, getDef(library, 'ADDER4'));
        wire(parent, makeInput(parent, 0).pins.out, inst.pins.cin!);
        // a=5, b=3 → sum=8
        const aBits = [1, 0, 1, 0];
        const bBits = [1, 1, 0, 0];
        for (let i = 0; i < 4; i++) {
          wire(parent, makeInput(parent, aBits[i]! as 0 | 1).pins.out, inst.pins[`a${i}`]!);
          wire(parent, makeInput(parent, bBits[i]! as 0 | 1).pins.out, inst.pins[`b${i}`]!);
        }
        const flat = flatten(parent, library);
        const netMap = flat.computeNets();
        const state = tick(flat, netMap, initialState(), soft ? 8 : 40);
        return readPins(state, netMap, inst, ['sum0', 'sum1', 'sum2', 'sum3', 'cout']);
      });
    expect(run(true)).toEqual(run(false));
  });

  it('ENCODER_8_3 matches', () => {
    const run = (soft: boolean) =>
      withSoftMode(soft, () => {
        const library = new ChipLibrary();
        seedStandardCells(library);
        const parent = new Circuit();
        const inst = makeChipInstance(parent, getDef(library, 'ENCODER_8_3'));
        for (let i = 0; i < 8; i++) {
          wire(parent, makeInput(parent, (i === 5 ? 1 : 0) as 0 | 1).pins.out, inst.pins[`in${i}`]!);
        }
        const flat = flatten(parent, library);
        const netMap = flat.computeNets();
        const state = tick(flat, netMap, initialState(), soft ? 8 : 40);
        return readPins(state, netMap, inst, ['y0', 'y1', 'y2']);
      });
    expect(run(true)).toEqual(run(false));
  });

  it('ALU4 add matches', () => {
    const run = (soft: boolean) =>
      withSoftMode(soft, () => {
        const library = new ChipLibrary();
        seedStandardCells(library);
        const parent = new Circuit();
        const inst = makeChipInstance(parent, getDef(library, 'ALU4'));
        // a=3, b=1, op=add → s=4
        for (let i = 0; i < 4; i++) {
          wire(parent, makeInput(parent, (i < 2 ? 1 : 0) as 0 | 1).pins.out, inst.pins[`a${i}`]!);
          wire(parent, makeInput(parent, (i === 0 ? 1 : 0) as 0 | 1).pins.out, inst.pins[`b${i}`]!);
        }
        wire(parent, makeInput(parent, 0).pins.out, inst.pins.op0!);
        wire(parent, makeInput(parent, 0).pins.out, inst.pins.op1!);
        const flat = flatten(parent, library);
        const netMap = flat.computeNets();
        const state = tick(flat, netMap, initialState(), soft ? 8 : 48);
        return readPins(state, netMap, inst, ['s0', 's1', 's2', 's3', 'cout']);
      });
    expect(run(true)).toEqual(run(false));
  });

  it('COUNTER8 matches after clear + count', () => {
    const run = (soft: boolean) =>
      withSoftMode(soft, () => {
        const library = new ChipLibrary();
        seedStandardCells(library);
        const parent = new Circuit();
        const inst = makeChipInstance(parent, getDef(library, 'COUNTER8'));
        const clr = makeInput(parent, 1);
        const ce = makeInput(parent, 1);
        const load = makeInput(parent, 0);
        const clk = makeInput(parent, 0);
        wire(parent, clr.pins.out, inst.pins.clr!);
        wire(parent, ce.pins.out, inst.pins.ce!);
        wire(parent, load.pins.out, inst.pins.load!);
        wire(parent, clk.pins.out, inst.pins.clk!);
        for (let i = 0; i < 8; i++) wire(parent, makeInput(parent, 0).pins.out, inst.pins[`d${i}`]!);
        let state = initialState();
        let netMap!: NetMap;
        const edge = () => {
          const r = risingEdge(parent, library, clk, state, soft ? 8 : 64);
          state = r.state;
          netMap = r.netMap;
        };
        edge();
        clr.value = 0;
        for (let i = 0; i < 3; i++) edge();
        return readPins(
          state,
          netMap,
          inst,
          Array.from({ length: 8 }, (_, i) => `q${i}`).concat(['co']),
        );
      });
    expect(run(true)).toEqual(run(false));
  });

  it('ALU8 soft add produces 0x12', () => {
    // Soft-only: full transistor ALU8 is too heavy for CI parity ticks.
    withSoftMode(true, () => {
      const library = new ChipLibrary();
      seedStandardCells(library);
      const parent = new Circuit();
      const inst = makeChipInstance(parent, getDef(library, 'ALU8'));
      for (let i = 0; i < 8; i++) {
        wire(parent, makeInput(parent, (i < 4 ? 1 : 0) as 0 | 1).pins.out, inst.pins[`a${i}`]!);
        wire(parent, makeInput(parent, (i < 2 ? 1 : 0) as 0 | 1).pins.out, inst.pins[`b${i}`]!);
      }
      wire(parent, makeInput(parent, 0).pins.out, inst.pins.op0!);
      wire(parent, makeInput(parent, 0).pins.out, inst.pins.op1!);
      const flat = flatten(parent, library);
      const netMap = flat.computeNets();
      const state = tick(flat, netMap, initialState(), 8);
      const s = readPins(
        state,
        netMap,
        inst,
        Array.from({ length: 8 }, (_, i) => `s${i}`).concat(['cout']),
      );
      // 0x0F + 0x03 = 0x12
      expect(s).toEqual({
        s0: 0,
        s1: 1,
        s2: 0,
        s3: 0,
        s4: 1,
        s5: 0,
        s6: 0,
        s7: 0,
        cout: 0,
      });
    });
  });

  it('SOFT_RAM16 soft write stores byte', () => {
    withSoftMode(true, () => {
      const library = new ChipLibrary();
      seedStandardCells(library);
      const parent = new Circuit();
      const inst = makeChipInstance(parent, getDef(library, 'SOFT_RAM16'));
      for (let i = 0; i < 4; i++) wire(parent, makeInput(parent, 0).pins.out, inst.pins[`addr${i}`]!);
      for (let i = 0; i < 8; i++) {
        wire(parent, makeInput(parent, (i < 4 ? 1 : 0) as 0 | 1).pins.out, inst.pins[`data${i}`]!);
      }
      const we = makeInput(parent, 1);
      const oe = makeInput(parent, 0);
      const clk = makeInput(parent, 0);
      wire(parent, we.pins.out, inst.pins.we!);
      wire(parent, oe.pins.out, inst.pins.oe!);
      wire(parent, clk.pins.out, inst.pins.clk!);

      let state = initialState();
      const hop = () => {
        const flat = flatten(parent, library);
        const netMap = flat.computeNets();
        state = tick(flat, netMap, state, 8);
      };
      clk.value = 0;
      hop();
      clk.value = 1;
      hop();
      expect(inst.softState?.q[0]).toBe(0x0f);
      // Soft Lab keeps the instance opaque.
      const flat = flatten(parent, library);
      const soft = [...flat.components.values()].find((c) => c.kind === 'chip' && c.softModel === 'SOFT_RAM16');
      expect(soft).toBeTruthy();
    });
  });
});
