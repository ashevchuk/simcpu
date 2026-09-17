/**
 * Orthogonal midpoints for a wire between two pin positions.
 * Kept in sim/ so hierarchy unfold can route without importing the UI layer.
 */
import type { Point } from './types.js';

/** One elbow (HVH or VHV) when endpoints are not already axis-aligned. */
export function orthoWaypoints(a: Point, b: Point): Point[] | undefined {
  if (a.x === b.x || a.y === b.y) return undefined;
  // Prefer horizontal-then-vertical (common for chip left/right stubs).
  return [{ x: b.x, y: a.y }];
}
