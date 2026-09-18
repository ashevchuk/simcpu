import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import {
  buildAlu,
  buildProgramCounter,
  buildRegister,
} from '../src/sim/blocks.js';
import { makeChipInstance, makeInput, makeSource, wire } from '../src/sim/library.js';
import { seedStandardCells } from '../src/sim/stdcells.js';
import { softLabModelKey } from '../src/sim/softLab.js';

/**
 * Soft Lab drives ChipDef ports by name. A missing name (HALF_ADDER out0 vs
 * sum, PISO without sout, …) leaves outputs floating while Soft Lab is on.
 * These checks pin the contract for every Soft Lab–modeled seed and for the
 * make*Chip path used when tests build Z80 pieces without seedStandardCells.
 */
describe('Soft Lab / ChipDef port-name alignment', () => {
  /** Ports Soft Lab reads or writes for each modeled chip (must ⊆ ChipDef.ports). */
  const softLabPorts: Record<string, string[]> = {
    HALF_ADDER: ['a', 'b', 'sum', 'cout'],
    FULL_ADDER: ['a', 'b', 'cin', 'sum', 'cout'],
    ADDER4: ['cin', 'a0', 'a1', 'a2', 'a3', 'b0', 'b1', 'b2', 'b3', 'sum0', 'sum1', 'sum2', 'sum3', 'cout'],
    ADDER8: [
      'cin',
      ...Array.from({ length: 8 }, (_, i) => `a${i}`),
      ...Array.from({ length: 8 }, (_, i) => `b${i}`),
      ...Array.from({ length: 8 }, (_, i) => `sum${i}`),
      'cout',
    ],
    ALU4: [
      ...Array.from({ length: 4 }, (_, i) => `a${i}`),
      ...Array.from({ length: 4 }, (_, i) => `b${i}`),
      'op0',
      'op1',
      ...Array.from({ length: 4 }, (_, i) => `s${i}`),
      'cout',
    ],
    ALU8: [
      ...Array.from({ length: 8 }, (_, i) => `a${i}`),
      ...Array.from({ length: 8 }, (_, i) => `b${i}`),
      'op0',
      'op1',
      ...Array.from({ length: 8 }, (_, i) => `s${i}`),
      'cout',
    ],
    SHIFT4_PISO: ['load', 'clk', 'd0', 'd1', 'd2', 'd3', 'q0', 'q1', 'q2', 'q3', 'sout'],
    SHIFT8_PISO: [
      'load',
      'clk',
      ...Array.from({ length: 8 }, (_, i) => `d${i}`),
      ...Array.from({ length: 8 }, (_, i) => `q${i}`),
      'sout',
    ],
    PISO8: [
      'load',
      'clk',
      ...Array.from({ length: 8 }, (_, i) => `d${i}`),
      ...Array.from({ length: 8 }, (_, i) => `q${i}`),
      'sout',
    ],
    '74165': [
      'load',
      'clk',
      ...Array.from({ length: 8 }, (_, i) => `d${i}`),
      ...Array.from({ length: 8 }, (_, i) => `q${i}`),
      'sout',
    ],
    '74157_1': ['sel', 'in0', 'in1', 'out'],
    MUX2: ['sel', 'in0', 'in1', 'out'],
    REG4: ['we', 'clk', 'd0', 'd1', 'd2', 'd3', 'q0', 'q1', 'q2', 'q3'],
    REG8: [
      'we',
      'clk',
      ...Array.from({ length: 8 }, (_, i) => `d${i}`),
      ...Array.from({ length: 8 }, (_, i) => `q${i}`),
    ],
    '7400': ['a', 'b', 'out'],
    '7404': ['in', 'out'],
    '7408': ['a', 'b', 'out'],
    '7432': ['a', 'b', 'out'],
    '7486': ['a', 'b', 'out'],
    '7474': ['d', 'clk', 'q', 'qn'],
    SR_LATCH: ['s', 'r', 'q', 'qn'],
    JK_FF: ['j', 'k', 'clk', 'q', 'qn'],
    T_FF: ['t', 'clr', 'clk', 'q', 'qn'],
  };

  it('seeded Soft Lab chips expose every port the soft model uses', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    for (const [name, need] of Object.entries(softLabPorts)) {
      const def = library.findByName(name);
      expect(def, name).toBeTruthy();
      const ports = new Set(def!.ports);
      for (const p of need) {
        expect(ports.has(p), `${name} missing port ${p} (have ${def!.ports.join(',')})`).toBe(true);
      }
      // Soft Lab models must resolve for Soft Lab chips (MUX2 is expand-only).
      if (name !== 'MUX2') {
        expect(softLabModelKey(name), name).toBeTruthy();
      }
    }
  });

  it('make*Chip path (no seedStandardCells) uses the same port names', () => {
    const library = new ChipLibrary();
    const parent = new Circuit();
    makeSource(parent, 1);
    makeSource(parent, 0);
    buildProgramCounter(parent, library, 3);
    expect(library.findByName('HALF_ADDER')!.ports).toEqual(['a', 'b', 'sum', 'cout']);
    expect(library.findByName('MUX2')!.ports).toEqual(['sel', 'in0', 'in1', 'out']);

    buildRegister(parent, library, 1, { x: 2000, y: 0 });
    expect(library.findByName('REG_BIT')!.ports).toEqual(['d', 'we', 'clk', 'q', 'qn']);

    buildAlu(parent, library, 1, { x: 4000, y: 0 });
    expect(library.findByName('ALU_SLICE')!.ports).toEqual([
      'a',
      'b',
      'cin',
      'op0',
      'op1',
      'out',
      'cout',
    ]);
  });

  it('74157_1 Soft Lab mux works against seeded MUX2 port names', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const def = library.findByName('74157_1')!;
    expect(def.ports).toEqual(['sel', 'in0', 'in1', 'out']);
    const parent = new Circuit();
    const inst = makeChipInstance(parent, def);
    const sel = makeInput(parent, 1);
    const in0 = makeInput(parent, 0);
    const in1 = makeInput(parent, 1);
    wire(parent, sel.pins.out, inst.pins.sel!);
    wire(parent, in0.pins.out, inst.pins.in0!);
    wire(parent, in1.pins.out, inst.pins.in1!);
    expect(inst.pins.out).toBeTruthy();
  });
});
