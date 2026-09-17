import type { Aabb, Point } from './types.js';

export function manhattan(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function pathLength(pts: Point[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += manhattan(pts[i - 1]!, pts[i]!);
  }
  return len;
}

/** Corner count (polyline verts minus 2). */
export function bendCount(pts: Point[]): number {
  return Math.max(0, pts.length - 2);
}

/** True if an axis-aligned segment crosses the *interior* of `box`. */
function segmentHitsAabb(a: Point, b: Point, box: Aabb, pad = 0): boolean {
  const minX = box.minX - pad;
  const maxX = box.maxX + pad;
  const minY = box.minY - pad;
  const maxY = box.maxY + pad;
  if (Math.abs(a.y - b.y) < 0.5) {
    const y = a.y;
    if (y <= minY || y >= maxY) return false;
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    // Touching the boundary only does not count as an interior hit.
    return x0 < maxX - 1e-6 && x1 > minX + 1e-6;
  }
  if (Math.abs(a.x - b.x) < 0.5) {
    const x = a.x;
    if (x <= minX || x >= maxX) return false;
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    return y0 < maxY - 1e-6 && y1 > minY + 1e-6;
  }
  return false;
}

/** True if any segment crosses an obstacle interior (endpoints may sit on pin pads). */
export function pathHitsObstacles(pts: Point[], obstacles: Aabb[]): boolean {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    for (const box of obstacles) {
      if (segmentHitsAabb(a, b, box)) return true;
    }
  }
  return false;
}

export function pointInObstacle(p: Point, box: Aabb, pad = 0): boolean {
  return (
    p.x > box.minX - pad &&
    p.x < box.maxX + pad &&
    p.y > box.minY - pad &&
    p.y < box.maxY + pad
  );
}

export function pointInAnyObstacle(p: Point, obstacles: Aabb[], pad = 0): boolean {
  return obstacles.some((box) => pointInObstacle(p, box, pad));
}

/** Colinear overlap length between two ortho segments. */
function orthoOverlapLength(a0: Point, a1: Point, b0: Point, b1: Point): number {
  const aH = Math.abs(a0.y - a1.y) < 0.5;
  const bH = Math.abs(b0.y - b1.y) < 0.5;
  if (aH !== bH) return 0;
  if (aH) {
    if (Math.abs(a0.y - b0.y) > 0.5) return 0;
    const lo = Math.max(Math.min(a0.x, a1.x), Math.min(b0.x, b1.x));
    const hi = Math.min(Math.max(a0.x, a1.x), Math.max(b0.x, b1.x));
    return Math.max(0, hi - lo);
  }
  if (Math.abs(a0.x - b0.x) > 0.5) return 0;
  const lo = Math.max(Math.min(a0.y, a1.y), Math.min(b0.y, b1.y));
  const hi = Math.min(Math.max(a0.y, a1.y), Math.max(b0.y, b1.y));
  return Math.max(0, hi - lo);
}

export function pathOverlapLength(path: Point[], others: Point[][]): number {
  if (!others.length || path.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a0 = path[i]!;
    const a1 = path[i + 1]!;
    for (const other of others) {
      for (let j = 0; j < other.length - 1; j++) {
        total += orthoOverlapLength(a0, a1, other[j]!, other[j + 1]!);
      }
    }
  }
  return total;
}
