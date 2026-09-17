import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/sim/Circuit.js';
import { makeInput, makeLabel, wire } from '../src/sim/library.js';
import { renameNet } from '../src/sim/netRename.js';

describe('renameNet', () => {
  it('names an unnamed net by placing a label', () => {
    const c = new Circuit();
    const a = makeInput(c, 0, { x: 0, y: 0 });
    const b = makeInput(c, 1, { x: 40, y: 0 });
    wire(c, a.pins.out, b.pins.out);
    const netId = c.computeNets().netOf.get(a.pins.out.id)!;
    const r = renameNet(c, netId, 'CLK');
    expect(r.ok).toBe(true);
    const labels = [...c.components.values()].filter((x) => x.kind === 'label');
    expect(labels).toHaveLength(1);
    expect(labels[0]!.name).toBe('CLK');
  });

  it('merges two nets that share a new name', () => {
    const c = new Circuit();
    const a = makeInput(c, 0, { x: 0, y: 0 });
    const b = makeInput(c, 1, { x: 80, y: 0 });
    makeLabel(c, 'A', { x: 10, y: -20 });
    // Connect label A to input a
    const labA = [...c.components.values()].find((x) => x.kind === 'label' && x.name === 'A');
    if (!labA || labA.kind !== 'label') throw new Error('missing label A');
    wire(c, a.pins.out, labA.pins.net);
    makeLabel(c, 'B', { x: 90, y: -20 });
    const labB = [...c.components.values()].find((x) => x.kind === 'label' && x.name === 'B');
    if (!labB || labB.kind !== 'label') throw new Error('missing label B');
    wire(c, b.pins.out, labB.pins.net);

    const netA = c.computeNets().netOf.get(a.pins.out.id)!;
    const r = renameNet(c, netA, 'B');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.merged).toBe(true);
    const nets = c.computeNets();
    expect(nets.netOf.get(a.pins.out.id)).toBe(nets.netOf.get(b.pins.out.id));
  });

  it('refuses VCC/GND', () => {
    const c = new Circuit();
    const a = makeInput(c, 0);
    const netId = c.computeNets().netOf.get(a.pins.out.id)!;
    expect(renameNet(c, netId, 'VCC').ok).toBe(false);
  });
});
