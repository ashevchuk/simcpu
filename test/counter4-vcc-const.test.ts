/**
 * COUNTER4: t0 = ce directly — no NOT(GND) / AND(VCC,ce) constant-1 stubs.
 */
import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { seedStandardCells } from '../src/sim/stdcells.js';

describe('COUNTER4 constant-1', () => {
  it('has no NOT(GND) or AND(VCC,·) stubs — t0 is ce', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    // Second seed must refresh a stale NOT(GND)/AND(VCC) COUNTER4 if present.
    seedStandardCells(library);
    const def = library.findByName('COUNTER4');
    expect(def).toBeTruthy();
    const nets = def!.circuit.computeNets();
    const gndNets = new Set<string>();
    const vccNets = new Set<string>();
    for (const c of def!.circuit.components.values()) {
      if (c.kind === 'source' && c.value === 0) {
        const n = nets.netOf.get(c.pins.out.id);
        if (n) gndNets.add(n);
      }
      if (c.kind === 'source' && c.value === 1) {
        const n = nets.netOf.get(c.pins.out.id);
        if (n) vccNets.add(n);
      }
      if (c.kind === 'label' && c.name === 'GND') {
        const n = nets.netOf.get(c.pins.net.id);
        if (n) gndNets.add(n);
      }
      if (c.kind === 'label' && c.name === 'VCC') {
        const n = nets.netOf.get(c.pins.net.id);
        if (n) vccNets.add(n);
      }
    }
    let notOnGnd = 0;
    let andOnVcc = 0;
    for (const c of def!.circuit.components.values()) {
      if (c.kind !== 'chip' || !library.has(c.defId)) continue;
      const name = library.get(c.defId).name;
      if ((name === 'NOT' || name === '7404') && c.pins.in) {
        const n = nets.netOf.get(c.pins.in.id);
        if (n && gndNets.has(n)) notOnGnd++;
      }
      if ((name === 'AND' || name === '7408') && (c.pins.a || c.pins.b)) {
        for (const pin of [c.pins.a, c.pins.b]) {
          if (!pin) continue;
          const n = nets.netOf.get(pin.id);
          if (n && vccNets.has(n)) andOnVcc++;
        }
      }
    }
    expect(notOnGnd).toBe(0);
    expect(andOnVcc).toBe(0);
  });
});
