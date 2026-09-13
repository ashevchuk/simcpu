import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/sim/Circuit.js';
import { makeInput, makeProbe } from '../src/sim/library.js';
import { distanceToSegment, findWaypointNear, findWireNear } from '../src/ui/geometry.js';

describe('distanceToSegment', () => {
  it('is 0 for a point on the segment', () => {
    expect(distanceToSegment({ x: 5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(0);
  });

  it('is the perpendicular distance for a point beside the segment', () => {
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(3);
  });

  it('clamps to the nearest endpoint beyond either end', () => {
    expect(distanceToSegment({ x: -4, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(4);
    expect(distanceToSegment({ x: 14, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(4);
  });
});

describe('findWaypointNear / findWireNear', () => {
  function wiredCircuit() {
    const circuit = new Circuit();
    const a = makeInput(circuit, 0, { x: 0, y: 0 });
    const b = makeProbe(circuit, { x: 100, y: 0 });
    const wire = circuit.addWire(a.pins.out.id, b.pins.in.id, [{ x: 50, y: 20 }]);
    return { circuit, a, b, wire };
  }

  it('findWaypointNear finds an existing bend point, not a pin endpoint', () => {
    const { circuit } = wiredCircuit();
    expect(findWaypointNear(circuit, { x: 51, y: 21 })).toEqual({ wireId: expect.any(String), index: 0 });
    expect(findWaypointNear(circuit, { x: 0, y: 0 })).toBeUndefined(); // that's a pin, not a waypoint
  });

  it('findWireNear picks the correct segment to insert into', () => {
    const { circuit, wire } = wiredCircuit();
    // Segment 0: pin a (0,0) -> waypoint (50,20). Midpoint ~(25,10).
    const nearFirstSegment = findWireNear(circuit, { x: 25, y: 10 });
    expect(nearFirstSegment).toEqual({ wireId: wire.id, insertIndex: 0 });

    // Segment 1: waypoint (50,20) -> pin b (100,0). Midpoint ~(75,10).
    const nearSecondSegment = findWireNear(circuit, { x: 75, y: 10 });
    expect(nearSecondSegment).toEqual({ wireId: wire.id, insertIndex: 1 });
  });

  it('findWireNear returns undefined beyond its radius', () => {
    const { circuit } = wiredCircuit();
    expect(findWireNear(circuit, { x: 25, y: 500 })).toBeUndefined();
  });
});
