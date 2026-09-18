/**
 * Soft Lab dive-in auto-expand: internals live while viewing, Soft again on leave.
 */
import { describe, expect, it } from 'vitest';
import counterLab from '../examples/lab-counter-7seg.json';
import { flatten } from '../src/sim/hierarchy.js';
import {
  clearSoftExpandForced,
  clearSoftLabPor,
  isSoftExpandForced,
  isSoftLabEnabled,
  setSoftLabEnabled,
  syncSoftExpandForDivePath,
} from '../src/sim/softLab.js';
import { deserializeProject, resolveStdcellInstances } from '../src/sim/serialize.js';
import { seedStandardCells } from '../src/sim/stdcells.js';
import { initialState, step } from '../src/sim/solver.js';
import { armSoftLabToGatesPor } from '../src/sim/softLab.js';
import type { Component, Level } from '../src/sim/types.js';

function loadCounterLab() {
  const { topCircuit, library } = deserializeProject(
    structuredClone(counterLab) as Parameters<typeof deserializeProject>[0],
  );
  seedStandardCells(library);
  resolveStdcellInstances(topCircuit, library);
  return { circuit: topCircuit, library };
}

function pinLevel(
  netMap: { netOf: Map<string, string> },
  state: { levelOf: Map<string, Level> },
  pinId: string,
): Level {
  const net = netMap.netOf.get(pinId);
  if (!net) return 'Z';
  return state.levelOf.get(net) ?? 'Z';
}

describe('syncSoftExpandForDivePath', () => {
  it('force-expands Soft Lab defs on path and releases them on leave', () => {
    const prev = isSoftLabEnabled();
    clearSoftExpandForced();
    try {
      setSoftLabEnabled(true);
      expect(syncSoftExpandForDivePath(['BCD_7SEG'])).toEqual(['BCD_7SEG']);
      expect(isSoftExpandForced('BCD_7SEG')).toBe(true);
      expect(syncSoftExpandForDivePath(['BCD_7SEG'])).toEqual([]); // already forced
      expect(syncSoftExpandForDivePath([])).toEqual([]);
      expect(isSoftExpandForced('BCD_7SEG')).toBe(false);
    } finally {
      clearSoftExpandForced();
      setSoftLabEnabled(prev);
    }
  });

  it('dive-expand BCD_7SEG makes internal nets live under Soft Lab', () => {
    const prev = isSoftLabEnabled();
    clearSoftExpandForced();
    clearSoftLabPor();
    try {
      const { circuit, library } = loadCounterLab();
      setSoftLabEnabled(true);
      // Soft opaque first.
      {
        const flat = flatten(circuit, library);
        expect(flat.computeNets().pinsOf.size).toBeLessThan(50);
      }
      const newly = syncSoftExpandForDivePath(['BCD_7SEG']);
      expect(newly).toEqual(['BCD_7SEG']);
      armSoftLabToGatesPor(circuit, library, new Set(newly));
      const flat = flatten(circuit, library);
      const nets = flat.computeNets();
      // COUNTER soft + BCD expanded ≈ 200+ nets (not full 494).
      expect(nets.pinsOf.size).toBeGreaterThan(100);
      expect(nets.pinsOf.size).toBeLessThan(400);
      let state = initialState(nets);
      for (let i = 0; i < 8; i++) state = step(flat, nets, state);
      const bcd = [...circuit.components.values()].find(
        (c): c is Extract<Component, { kind: 'chip' }> =>
          c.kind === 'chip' && library.get(c.defId)?.name === 'BCD_7SEG',
      )!;
      // Digit 0 from soft COUNTER q=0 → segment a high.
      expect(pinLevel(nets, state, bcd.pins.a!.id)).toBe(1);
      expect(pinLevel(nets, state, bcd.pins.g!.id)).toBe(0);

      syncSoftExpandForDivePath([]);
      expect(isSoftExpandForced('BCD_7SEG')).toBe(false);
      expect(flatten(circuit, library).computeNets().pinsOf.size).toBeLessThan(50);
    } finally {
      clearSoftLabPor();
      clearSoftExpandForced();
      setSoftLabEnabled(prev);
    }
  });
});
