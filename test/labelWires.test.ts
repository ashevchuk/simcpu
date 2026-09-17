import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/sim/Circuit.js';
import { compactCircuitLayout, replaceLongWiresWithLabels } from '../src/sim/labelWires.js';
import { makeLabel, makeSource, wire } from '../src/sim/library.js';

describe('replaceLongWiresWithLabels', () => {
  it('turns a long wire into two same-named labels and keeps the net', () => {
    const c = new Circuit();
    const a = makeSource(c, 1, { x: 0, y: 0 });
    const b = makeSource(c, 0, { x: 500, y: 0 });
    wire(c, a.pins.out, b.pins.out);
    expect(c.wires.size).toBe(1);

    const removed = replaceLongWiresWithLabels(c, 100);
    expect(removed).toBe(1);

    const labels = [...c.components.values()].filter((x) => x.kind === 'label');
    expect(labels.length).toBe(2);
    expect(labels[0]!.name).toBe(labels[1]!.name);

    const nets = c.computeNets();
    expect(nets.netOf.get(a.pins.out.id)).toBe(nets.netOf.get(b.pins.out.id));

    for (const w of c.wires.values()) {
      const pa = [...c.components.values()].flatMap((comp) => Object.values(comp.pins));
      const pinA = pa.find((p) => p.id === w.a)!;
      const pinB = pa.find((p) => p.id === w.b)!;
      expect(Math.hypot(pinA.pos.x - pinB.pos.x, pinA.pos.y - pinB.pos.y)).toBeLessThan(100);
    }
  });

  it('leaves short wires alone', () => {
    const c = new Circuit();
    const a = makeSource(c, 1, { x: 0, y: 0 });
    const b = makeSource(c, 0, { x: 40, y: 0 });
    wire(c, a.pins.out, b.pins.out);
    expect(replaceLongWiresWithLabels(c, 100)).toBe(0);
    expect(c.wires.size).toBe(1);
  });

  it('converts wires at the threshold (inclusive)', () => {
    const c = new Circuit();
    const a = makeSource(c, 1, { x: 0, y: 0 });
    const b = makeSource(c, 0, { x: 24, y: 0 });
    wire(c, a.pins.out, b.pins.out);
    expect(replaceLongWiresWithLabels(c, 24)).toBe(1);
    expect([...c.components.values()].filter((x) => x.kind === 'label').length).toBe(2);
  });

  it('drops a redundant wire between two same-named labels', () => {
    const c = new Circuit();
    const la = makeLabel(c, 'BUS0', { x: 0, y: 0 });
    const lb = makeLabel(c, 'BUS0', { x: 800, y: 0 });
    wire(c, la.pins.net, lb.pins.net);
    expect(replaceLongWiresWithLabels(c, 100)).toBe(1);
    expect(c.wires.size).toBe(0);
    const nets = c.computeNets();
    expect(nets.netOf.get(la.pins.net.id)).toBe(nets.netOf.get(lb.pins.net.id));
  });
});

describe('compactCircuitLayout', () => {
  it('scales positions toward the centroid', () => {
    const c = new Circuit();
    makeSource(c, 1, { x: 0, y: 0 });
    makeSource(c, 0, { x: 200, y: 0 });
    compactCircuitLayout(c, 0.5);
    const positions = [...c.components.values()].map((x) => x.pos.x).sort((a, b) => a - b);
    expect(positions[0]).toBeCloseTo(50);
    expect(positions[1]).toBeCloseTo(150);
  });
});
