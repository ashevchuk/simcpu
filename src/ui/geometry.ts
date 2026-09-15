import { CHIP_INSTANCE_WIDTH, chipBodyWidth, chipBoxHeight, chipInstanceHeight, ramPortCount, romPortCount } from '../sim/library.js';
import type { Circuit } from '../sim/Circuit.js';
import type { Component, Pin, Point, Wire } from '../sim/types.js';

export const GRID = 20;

export function snap(p: Point): Point {
  return { x: Math.round(p.x / GRID) * GRID, y: Math.round(p.y / GRID) * GRID };
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Orthogonal polyline between two points — HVH when wider, VHV when taller. */
export function orthogonalPoints(a: Point, b: Point): Point[] {
  if (Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5) return [a, b];
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  if (dx >= dy) {
    const midX = (a.x + b.x) / 2;
    return [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b];
  }
  const midY = (a.y + b.y) / 2;
  return [a, { x: a.x, y: midY }, { x: b.x, y: midY }, b];
}

/** Expand explicit waypoints into an orthogonal path (each leg H or V). */
export function routeWirePoints(raw: Point[]): Point[] {
  if (raw.length < 2) return raw;
  const out: Point[] = [raw[0]!];
  for (let i = 1; i < raw.length; i++) {
    const prev = out[out.length - 1]!;
    const next = raw[i]!;
    const seg = orthogonalPoints(prev, next);
    for (let j = 1; j < seg.length; j++) out.push(seg[j]!);
  }
  return out.filter((p, i, arr) => i === 0 || p.x !== arr[i - 1]!.x || p.y !== arr[i - 1]!.y);
}

/** H↔V crossings between orthogonal polylines (schematic junction dots). */
export function findWireCrossings(paths: Point[][]): Point[] {
  type Seg = { x1: number; y1: number; x2: number; y2: number; horiz: boolean };
  const segs: Seg[] = [];
  for (const path of paths) {
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5) continue;
      const horiz = Math.abs(a.y - b.y) < 0.5;
      segs.push({
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        horiz,
      });
    }
  }
  const out: Point[] = [];
  const key = (p: Point) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  const seen = new Set<string>();
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const a = segs[i]!;
      const b = segs[j]!;
      if (a.horiz === b.horiz) continue;
      const h = a.horiz ? a : b;
      const v = a.horiz ? b : a;
      const y = h.y1;
      const x = v.x1;
      const hMinX = Math.min(h.x1, h.x2);
      const hMaxX = Math.max(h.x1, h.x2);
      const vMinY = Math.min(v.y1, v.y2);
      const vMaxY = Math.max(v.y1, v.y2);
      if (x <= hMinX + 0.5 || x >= hMaxX - 0.5) continue;
      if (y <= vMinY + 0.5 || y >= vMaxY - 0.5) continue;
      const p = { x, y };
      const k = key(p);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
  }
  return out;
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
        return [chipBodyWidth(c) / 2, chipBoxHeight(c) / 2];
      case 'ram':
        return [CHIP_INSTANCE_WIDTH / 2, chipInstanceHeight(ramPortCount(c)) / 2];
      case 'rom':
        return [CHIP_INSTANCE_WIDTH / 2, chipInstanceHeight(romPortCount(c)) / 2];
      case 'source':
        return [16, 8];
      case 'transistor':
        return [22, 28];
      case 'input':
      case 'button':
        return [14, 12];
      case 'clock':
        return [22, 16];
      case 'analyzer':
        return [32, Math.max(20, (c.channelCount * 16) / 2 + 8)];
      case 'tty':
        return [36, 22];
      case 'led':
      case 'probe':
      case 'port':
        return [12, 12];
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

/** Stored wire polyline (pin → waypoints → pin), before orthogonal expansion. */
export function rawWirePolyline(circuit: Circuit, wire: Wire): Point[] | undefined {
  const pinById = new Map<string, Point>();
  for (const p of circuit.allPins()) pinById.set(p.id, p.pos);
  const a = pinById.get(wire.a);
  const b = pinById.get(wire.b);
  if (!a || !b) return undefined;
  return wire.waypoints && wire.waypoints.length ? [a, ...wire.waypoints, b] : [a, b];
}

/** Drawn wire polyline — orthogonalized to match Renderer. */
export function wirePolyline(circuit: Circuit, wire: Wire): Point[] | undefined {
  const raw = rawWirePolyline(circuit, wire);
  return raw ? routeWirePoints(raw) : undefined;
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
 * Nearest wire *segment* to `p` within `radius`. Hit-tests the drawn
 * orthogonal path, but `insertIndex` indexes the stored waypoint list
 * (segment i of pin→waypoints→pin), so a drag still inserts a real bend.
 */
export function findWireNear(circuit: Circuit, p: Point, radius = 6): { wireId: string; insertIndex: number } | undefined {
  let best: { wireId: string; insertIndex: number } | undefined;
  let bestDist = radius;
  for (const w of circuit.wires.values()) {
    const raw = rawWirePolyline(circuit, w);
    if (!raw) continue;
    for (let i = 0; i < raw.length - 1; i++) {
      const ortho = orthogonalPoints(raw[i]!, raw[i + 1]!);
      for (let j = 0; j < ortho.length - 1; j++) {
        const d = distanceToSegment(p, ortho[j]!, ortho[j + 1]!);
        if (d <= bestDist) {
          best = { wireId: w.id, insertIndex: i };
          bestDist = d;
        }
      }
    }
  }
  return best;
}
