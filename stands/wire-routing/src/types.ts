export type Point = { x: number; y: number };

export type Aabb = { minX: number; minY: number; maxX: number; maxY: number };

export type RouteDir = 'N' | 'S' | 'E' | 'W';

export interface RouteRequest {
  from: Point;
  to: Point;
  obstacles: Aabb[];
  startDir?: RouteDir | null;
  endDir?: RouteDir | null;
  /** Existing polylines — colinear overlap is costly (fanout channels). */
  avoidOverlap?: Point[][];
  grid?: number;
  /** Extra cost when the path changes direction (typical 1.5–3). */
  bendCost?: number;
  /** Extra cost per grid step that overlaps an avoidOverlap trunk. */
  overlapCost?: number;
}

export interface FixtureNet {
  id: string;
  from: Point;
  to: Point;
  startDir?: RouteDir | null;
  endDir?: RouteDir | null;
  /** Per-net obstacles (endpoint hosts already excluded). Falls back to fixture.obstacles. */
  obstacles?: Aabb[];
  /** Soft ceilings; omitted = unchecked. */
  maxBends?: number;
  maxLength?: number;
}

export interface Fixture {
  name: string;
  description?: string;
  grid?: number;
  obstacles: Aabb[];
  /** Route nets in order; later nets see earlier paths as avoidOverlap. */
  nets: FixtureNet[];
}
