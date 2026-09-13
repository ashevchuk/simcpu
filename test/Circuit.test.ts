import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/sim/Circuit.js';
import { makeInput, makeProbe } from '../src/sim/library.js';

describe('Circuit.moveComponent', () => {
  it('translates the component and every one of its pins by the same delta', () => {
    const circuit = new Circuit();
    const input = makeInput(circuit, 0, { x: 10, y: 20 });
    const beforePin = { ...input.pins.out.pos };

    circuit.moveComponent(input.id, 5, -8);

    expect(input.pos).toEqual({ x: 15, y: 12 });
    expect(input.pins.out.pos).toEqual({ x: beforePin.x + 5, y: beforePin.y - 8 });
  });

  it('keeps a connected wire resolving to the same net after either end moves', () => {
    const circuit = new Circuit();
    const a = makeInput(circuit, 0, { x: 0, y: 0 });
    const b = makeProbe(circuit, { x: 100, y: 0 });
    circuit.addWire(a.pins.out.id, b.pins.in.id);

    circuit.moveComponent(a.id, 40, 40);
    circuit.moveComponent(b.id, -10, 5);

    const netMap = circuit.computeNets();
    expect(netMap.netOf.get(a.pins.out.id)).toBe(netMap.netOf.get(b.pins.in.id));
  });

  it("does not move a wire's existing waypoints — only its endpoints", () => {
    const circuit = new Circuit();
    const a = makeInput(circuit, 0, { x: 0, y: 0 });
    const b = makeProbe(circuit, { x: 100, y: 0 });
    const wire = circuit.addWire(a.pins.out.id, b.pins.in.id, [{ x: 50, y: 20 }]);

    circuit.moveComponent(a.id, 1000, 1000);

    expect(wire.waypoints).toEqual([{ x: 50, y: 20 }]);
  });

  it('is a no-op for an unknown id', () => {
    const circuit = new Circuit();
    expect(() => circuit.moveComponent('does-not-exist', 1, 1)).not.toThrow();
  });
});
