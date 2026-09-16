import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/sim/Circuit.js';
import { makeInput, makeProbe } from '../src/sim/library.js';
import {
  distanceToSegment,
  findWaypointNear,
  findWireNear,
  pinExitDir,
  routeAStar,
  routeWirePoints,
  simplifyOrthoPath,
  type Aabb,
} from '../src/ui/geometry.js';

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
    const { circuit, a, b, wire } = wiredCircuit();
    // Segment 0: pin a → waypoint (50,20). L-route: (0,0)→(50,0)→(50,20).
    const nearFirstSegment = findWireNear(circuit, {
      x: 25,
      y: 0,
    });
    expect(nearFirstSegment).toEqual({ wireId: wire.id, insertIndex: 0 });

    // Segment 1: waypoint (50,20) → pin b. L-route: (50,20)→(100,20)→(100,0).
    const nearSecondSegment = findWireNear(circuit, {
      x: 75,
      y: 20,
    });
    expect(nearSecondSegment).toEqual({ wireId: wire.id, insertIndex: 1 });
  });

  it('findWireNear returns undefined beyond its radius', () => {
    const { circuit } = wiredCircuit();
    expect(findWireNear(circuit, { x: 25, y: 500 })).toBeUndefined();
  });
});

describe('routeWirePoints obstacles', () => {
  it('pinExitDir prefers leaving away from the body', () => {
    expect(pinExitDir({ x: 0, y: 50 }, { x: 28, y: 50 })).toBe('W'); // gate-like
    expect(pinExitDir({ x: 50, y: 0 }, { x: 50, y: 28 })).toBe('N'); // drain-like
  });

  it('uses a single L-corner by default (not a mid-Z)', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 40 };
    expect(routeWirePoints([a, b])).toEqual([a, { x: 100, y: 0 }, b]);
  });

  it('honours startDir when choosing an L-corner', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 80 };
    const routed = routeWirePoints([a, b], { startDir: 'S' });
    expect(routed[0]).toEqual(a);
    expect(routed[1]!.y).toBeGreaterThan(a.y); // first step goes south
  });

  it('detours around a blocking AABB instead of cutting through it', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 0 };
    const box: Aabb = { minX: 40, minY: -20, maxX: 60, maxY: 20 };
    const plain = routeWirePoints([a, b]);
    expect(plain).toEqual([a, b]);

    const routed = routeWirePoints([a, b], [box]);
    const hitsBox = routed.some((p, i) => {
      if (i === 0) return false;
      const prev = routed[i - 1]!;
      const y = Math.abs(prev.y - p.y) < 0.5 ? prev.y : null;
      if (y === null || y <= box.minY || y >= box.maxY) return false;
      const x0 = Math.min(prev.x, p.x);
      const x1 = Math.max(prev.x, p.x);
      return x0 < box.maxX && x1 > box.minX;
    });
    expect(hitsBox).toBe(false);
    expect(routed[0]).toEqual(a);
    expect(routed[routed.length - 1]).toEqual(b);
    expect(routed.length).toBeGreaterThan(2);
  });

  it('falls back to an L-shape when every candidate still collides', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 40, y: 40 };
    const wall: Aabb = { minX: -200, minY: -200, maxX: 200, maxY: 200 };
    const routed = routeWirePoints([a, b], [wall]);
    expect(routed).toEqual([a, { x: 40, y: 0 }, b]);
  });

  it('simplifyOrthoPath collapses colinear elbows', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 40 },
    ];
    expect(simplifyOrthoPath(pts)).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 40 },
    ]);
  });

  it('simplifyOrthoPath keeps overshoot elbows (no floating handles)', () => {
    const pts = [
      { x: 0, y: 50 },
      { x: 150, y: 50 },
      { x: 100, y: 50 },
      { x: 100, y: 100 },
    ];
    expect(simplifyOrthoPath(pts)).toEqual(pts);
    const drawn = routeWirePoints([
      { x: 0, y: 50 },
      { x: 150, y: 50 },
      { x: 100, y: 100 },
    ]);
    expect(drawn.some((p) => Math.abs(p.x - 150) < 0.5 && Math.abs(p.y - 50) < 0.5)).toBe(true);
  });

  it('routeAStar clears a blocking body', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 0 };
    const box: Aabb = { minX: 30, minY: -40, maxX: 70, maxY: 40 };
    const star = routeAStar(a, b, [box], 10);
    expect(star).toBeTruthy();
    expect(star![0]).toEqual(a);
    expect(star![star!.length - 1]).toEqual(b);
    // Must leave the blocked band on y=0 between x=30..70.
    const hits = star!.some((p, i) => {
      if (i === 0) return false;
      const prev = star![i - 1]!;
      if (Math.abs(prev.y - p.y) > 0.5) return false;
      if (Math.abs(prev.y) > 0.5) return false;
      const x0 = Math.min(prev.x, p.x);
      const x1 = Math.max(prev.x, p.x);
      return x0 < 70 && x1 > 30;
    });
    expect(hits).toBe(false);
  });
});
