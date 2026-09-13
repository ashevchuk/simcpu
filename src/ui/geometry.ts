import { CHIP_INSTANCE_WIDTH, chipInstanceHeight, ramPortCount } from '../sim/library.js';
import type { Circuit } from '../sim/Circuit.js';
import type { Component, Pin, Point, Wire } from '../sim/types.js';

export const GRID = 20;

export function snap(p: Point): Point {
  return { x: Math.round(p.x / GRID) * GRID, y: Math.round(p.y / GRID) * GRID };
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Nearest pin to `p` within `radius`, or undefined if none qualifies. */
export function findPinNear(circuit: Circuit, p: Point, radius = 10): Pin | undefined {
  let best: Pin | undefined;
  let bestDist = radius;
  for (const pin of circuit.allPins()) {
    const d = dist(pin.pos, p);
    if (d <= bestDist) {
      best = pin;
      bestDist = d;
    }
  }
  return best;
}

// Hit-targets are padded a few units past the drawn body on every side —
// a mouse (let alone a trackpad) is nowhere near pixel-precise, and a hit
// box that exactly matched the visual size (found by hand while chasing
// what looked like a broken drag: it wasn't, the click had just landed a
// few units outside a `source`'s tight 16x8 box) makes small parts
// frustrating to grab for a real click, not just an automated one.
const HIT_PAD = 6;

/** Half-width/half-height of a component's clickable area — a bit larger than Renderer.ts's drawn body, see HIT_PAD. */
function boundsHalfSize(c: Component): [number, number] {
  const [hw, hh] = ((): [number, number] => {
    switch (c.kind) {
      case 'chip':
        return [CHIP_INSTANCE_WIDTH / 2, chipInstanceHeight(Object.keys(c.pins).length) / 2];
      case 'ram':
        return [CHIP_INSTANCE_WIDTH / 2, chipInstanceHeight(ramPortCount(c)) / 2];
      case 'source':
        return [16, 8];
      case 'input':
        return [12, 10];
      case 'probe':
      case 'port':
        return [10, 10];
      default:
        return [14, 14];
    }
  })();
  return [hw + HIT_PAD, hh + HIT_PAD];
}

/** Component whose drawn body contains `p`. */
export function findComponentNear(circuit: Circuit, p: Point) {
  for (const c of circuit.components.values()) {
    const [hw, hh] = boundsHalfSize(c);
    if (Math.abs(c.pos.x - p.x) <= hw && Math.abs(c.pos.y - p.y) <= hh) return c;
  }
  return undefined;
}

/** The polyline a wire is actually drawn as — its pin's position, then its waypoints in order, then its other pin's position. */
export function wirePolyline(circuit: Circuit, wire: Wire): Point[] | undefined {
  const pinById = new Map<string, Point>();
  for (const p of circuit.allPins()) pinById.set(p.id, p.pos);
  const a = pinById.get(wire.a);
  const b = pinById.get(wire.b);
  if (!a || !b) return undefined;
  return wire.waypoints && wire.waypoints.length ? [a, ...wire.waypoints, b] : [a, b];
}

/** Shortest distance from `p` to the segment a-b (0 when `p` projects outside the segment, clamped to an endpoint). */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Nearest *existing* bend point to `p` (a pin endpoint never counts), for grabbing one to drag. */
export function findWaypointNear(circuit: Circuit, p: Point, radius = 8): { wireId: string; index: number } | undefined {
  let best: { wireId: string; index: number } | undefined;
  let bestDist = radius;
  for (const w of circuit.wires.values()) {
    if (!w.waypoints) continue;
    w.waypoints.forEach((wp, index) => {
      const d = dist(wp, p);
      if (d <= bestDist) {
        best = { wireId: w.id, index };
        bestDist = d;
      }
    });
  }
  return best;
}

/**
 * Nearest wire *segment* to `p` within `radius`, and where a freshly-grabbed
 * bend point should land in that wire's `waypoints` array — which happens
 * to be the same index as the segment itself in the full a/waypoints/b
 * point list, since each segment i sits between points[i] and points[i+1].
 */
export function findWireNear(circuit: Circuit, p: Point, radius = 6): { wireId: string; insertIndex: number } | undefined {
  let best: { wireId: string; insertIndex: number } | undefined;
  let bestDist = radius;
  for (const w of circuit.wires.values()) {
    const points = wirePolyline(circuit, w);
    if (!points) continue;
    for (let i = 0; i < points.length - 1; i++) {
      const d = distanceToSegment(p, points[i]!, points[i + 1]!);
      if (d <= bestDist) {
        best = { wireId: w.id, insertIndex: i };
        bestDist = d;
      }
    }
  }
  return best;
}
