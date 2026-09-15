import { describe, expect, it } from 'vitest';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { foldZ80CpuLeavingRam, newComponentIds } from '../src/sim/foldZ80.js';
import { flatten } from '../src/sim/hierarchy.js';
import { initialState, step } from '../src/sim/solver.js';
import { makeInput, wire } from '../src/sim/library.js';

describe('foldZ80CpuLeavingRam', () => {
  it('leaves RAM on the parent and collapses the rest into one chip', () => {
    const library = new ChipLibrary();
    const parent = new Circuit();
    const before = new Set(parent.components.keys());
    const program = new Uint8Array([0x00]); // NOP
    const cpu = buildZ80Cpu(parent, library, 6, program, { x: 0, y: 0 });
    const placed = newComponentIds(parent, before);
    const nFlat = parent.components.size;

    expect(placed.includes(cpu.ram.id)).toBe(true);
    expect(nFlat).toBeGreaterThan(100);

    const { instance } = foldZ80CpuLeavingRam(parent, library, placed, { x: 0, y: 0 });

    expect(parent.components.get(cpu.ram.id)?.kind).toBe('ram');
    expect(instance.kind).toBe('chip');
    expect(parent.components.has(instance.id)).toBe(true);
    // One chip + one RAM (+ no runner Inputs in this test) — dramatic shrink.
    expect(parent.components.size).toBeLessThan(10);
    expect(parent.components.size).toBeLessThan(nFlat / 50);
  });

  it('still simulates a NOP after fold when clocks are wired outside', () => {
    const library = new ChipLibrary();
    const parent = new Circuit();
    const before = new Set(parent.components.keys());
    const cpu = buildZ80Cpu(parent, library, 6, new Uint8Array([0x00, 0x00]), { x: 0, y: 0 });
    const placed = newComponentIds(parent, before);

    const reset = makeInput(parent, 1);
    wire(parent, reset.pins.out, cpu.reset);
    const aReset = makeInput(parent, 1);
    wire(parent, aReset.pins.out, cpu.aReset);
    const dataClk = makeInput(parent, 0);
    wire(parent, dataClk.pins.out, cpu.clk);
    const phaseClk = makeInput(parent, 0);
    wire(parent, phaseClk.pins.out, cpu.phaseClk);
    const fsmLoad = makeInput(parent, 1);
    wire(parent, fsmLoad.pins.out, cpu.fsmLoad);
    for (let i = 0; i < cpu.fsmD.length; i++) {
      const d = makeInput(parent, i === 0 ? 1 : 0);
      wire(parent, d.pins.out, cpu.fsmD[i]!);
    }

    foldZ80CpuLeavingRam(parent, library, placed, { x: 0, y: 0 });

    let state = initialState();
    const tick = () => {
      const flat = flatten(parent, library);
      state = step(flat, flat.computeNets(), state, 300);
    };
    const pulse = (sig: { value: 0 | 1 }) => {
      sig.value = 1;
      tick();
      sig.value = 0;
      tick();
    };

    tick();
    pulse(phaseClk);
    fsmLoad.value = 0;
    pulse(dataClk);
    reset.value = 0;
    aReset.value = 0;
    pulse(dataClk); // fetch NOP
    // Should settle without contention after a folded placement.
    expect(state.contended.size).toBe(0);
    expect(parent.components.get(cpu.ram.id)?.kind).toBe('ram');
  });
});
