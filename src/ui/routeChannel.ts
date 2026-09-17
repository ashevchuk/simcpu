/**
 * Escape-then-channel orthogonal router (stand B → production).
 * Used for tidy/commit; rubber-band drawing stays on the pattern catalog.
 */
import type { Point } from '../sim/types.js';
import type { Aabb, RouteDir, RouteLane } from './geometry.js';

const GRID = 10;

function snap(p: Point, step: number): Point {
  return { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step };
}

function stepDir(p: Point, dir: RouteDir, dist: number): Point {
  switch (dir) {
    case 'N':
      return { x: p.x, y: p.y - dist };
    case 'S':
      return { x: p.x, y: p.y + dist };
    case 'E':
      return { x: p.x + dist, y: p.y };
    case 'W':
      return { x: p.x - dist, y: p.y };
  }
}

function dirDelta(d: RouteDir): [number, number] {
  return d === 'E' ? [1, 0] : d === 'W' ? [-1, 0] : d === 'S' ? [0, 1] : [0, -1];
}

/** Axis a pin fires along: 'h' for E/W, 'v' for N/S. */
type Axis = 'h' | 'v';

function dirAxis(d: RouteDir | null | undefined): Axis | null {
  if (!d) return null;
  return d === 'E' || d === 'W' ? 'h' : 'v';
}

/** True when `other` lies in front of a pin firing along `dir`. */
function isAhead(pin: Point, other: Point, dir: RouteDir | null | undefined, step: number): boolean {
  if (!dir) return true;
  const [ex, ey] = dirDelta(dir);
  return (other.x - pin.x) * ex + (other.y - pin.y) * ey > step * 0.5;
}

function manhattan(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** Distance from `pin` to `other` measured along the pin's exit axis. */
function gapAlong(pin: Point, other: Point, dir: RouteDir | null | undefined): number {
  if (!dir) return Infinity;
  return dir === 'E' || dir === 'W' ? Math.abs(other.x - pin.x) : Math.abs(other.y - pin.y);
}

function pointInObstacle(p: Point, box: Aabb, pad = 0): boolean {
  return (
    p.x > box.minX - pad &&
    p.x < box.maxX + pad &&
    p.y > box.minY - pad &&
    p.y < box.maxY + pad
  );
}

function pointInAnyObstacle(p: Point, obstacles: Aabb[], pad = 0): boolean {
  return obstacles.some((box) => pointInObstacle(p, box, pad));
}

/** Interior hit (pad 0) — pins may sit on package edges. */
function segmentHitsInterior(a: Point, b: Point, box: Aabb): boolean {
  if (Math.abs(a.y - b.y) < 0.5) {
    const y = a.y;
    if (y <= box.minY || y >= box.maxY) return false;
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    return x0 < box.maxX && x1 > box.minX;
  }
  if (Math.abs(a.x - b.x) < 0.5) {
    const x = a.x;
    if (x <= box.minX || x >= box.maxX) return false;
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    return y0 < box.maxY && y1 > box.minY;
  }
  return false;
}

function pathHitsInterior(pts: Point[], obstacles: Aabb[]): boolean {
  for (let i = 0; i < pts.length - 1; i++) {
    for (const box of obstacles) {
      if (segmentHitsInterior(pts[i]!, pts[i + 1]!, box)) return true;
    }
  }
  return false;
}

/**
 * Host-body check for a pin→pin candidate. Chip pins sit slightly inside the
 * package box, so the first/last segment may cross it — but only while
 * travelling along the pin's exit direction. Any other segment through a host
 * body means the route loops back across its own package (the "U behind the
 * pin" seen when two chips almost touch).
 */
function pathCrossesHost(
  pts: Point[],
  hosts: Aabb[],
  startDir: RouteDir | null | undefined,
  endDir: RouteDir | null | undefined,
): boolean {
  if (!hosts.length) return false;
  const from = pts[0]!;
  const to = pts[pts.length - 1]!;
  const sd = startDir ? dirDelta(startDir) : null;
  const ed = endDir ? dirDelta(endDir) : null;
  // A point in front of both pins can only touch the pin-inset rim of a
  // package (pins sit a few px inside the box) — never its far side.
  const aheadOfBoth = (p: Point): boolean =>
    !!sd &&
    !!ed &&
    (p.x - from.x) * sd[0] + (p.y - from.y) * sd[1] >= -0.5 &&
    (p.x - to.x) * ed[0] + (p.y - to.y) * ed[1] >= -0.5;
  const last = pts.length - 2;
  for (let i = 0; i <= last; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (aheadOfBoth(a) && aheadOfBoth(b)) continue;
    if (i === 0 && startDir) {
      const [ex, ey] = dirDelta(startDir);
      if ((b.x - a.x) * ex + (b.y - a.y) * ey > 0.5) continue;
    }
    if (i === last && endDir) {
      const [ex, ey] = dirDelta(endDir);
      // Entering the pin means travelling against its exit direction.
      if ((b.x - a.x) * ex + (b.y - a.y) * ey < -0.5) continue;
    }
    for (const box of hosts) {
      if (segmentHitsInterior(a, b, box)) return true;
    }
  }
  return false;
}

function isColinearOrtho(a: Point, b: Point, c: Point): boolean {
  const sameX =
    Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5 && Math.abs(a.x - c.x) < 0.5;
  const sameY =
    Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5 && Math.abs(a.y - c.y) < 0.5;
  return sameX || sameY;
}

/** Drop colinear mids (between or overshoot) and a→b→a spurs. */
export function simplifyChannelPath(pts: Point[]): Point[] {
  if (pts.length <= 2) return pts;
  const out: Point[] = [{ ...pts[0]! }];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]!;
    const prev = out[out.length - 1]!;
    if (Math.abs(p.x - prev.x) < 0.5 && Math.abs(p.y - prev.y) < 0.5) continue;
    out.push({ ...p });
  }
  let changed = true;
  while (changed && out.length > 2) {
    changed = false;
    for (let i = 1; i < out.length - 1; i++) {
      if (isColinearOrtho(out[i - 1]!, out[i]!, out[i + 1]!)) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  changed = true;
  while (changed && out.length >= 3) {
    changed = false;
    for (let i = 0; i < out.length - 2; i++) {
      const a = out[i]!;
      const c = out[i + 2]!;
      if (Math.abs(a.x - c.x) < 0.5 && Math.abs(a.y - c.y) < 0.5) {
        out.splice(i + 1, 2);
        changed = true;
        break;
      }
    }
  }
  return out;
}

export interface ChannelRouteRequest {
  from: Point;
  to: Point;
  obstacles: Aabb[];
  /**
   * Bodies of the wire's own endpoint components. Pin stubs may leave them,
   * but the channel search must not tunnel through the package — otherwise a
   * route can approach a pin from the wrong side, across its own chip.
   */
  hostObstacles?: Aabb[];
  startDir?: RouteDir | null;
  endDir?: RouteDir | null;
  avoidOverlap?: Point[][];
  /** Approach rows/columns of wires that will be routed after this one. */
  reservedLanes?: RouteLane[];
  grid?: number;
  bendCost?: number;
  overlapCost?: number;
}

const DEFAULT_BEND = 2.5;
const DEFAULT_OVERLAP = 8;
const MAX_CELLS = 40_000;

/**
 * Walk exitDir until clear. Skip forced stub when `toward` lies against exit dir.
 */
export function escapePoint(
  pin: Point,
  dir: RouteDir | null | undefined,
  obstacles: Aabb[],
  step: number,
  minSteps = 2,
  toward?: Point,
): Point {
  if (!dir) return snap(pin, step);
  let forced = minSteps;
  if (toward) {
    const dx = toward.x - pin.x;
    const dy = toward.y - pin.y;
    const [ex, ey] = dirDelta(dir);
    if (dx * ex + dy * ey < -0.5) forced = 0;
    // Facing / near-aligned: one-grid stub is enough (callers asking for a
    // longer escape want the clearance, so don't shrink theirs).
    else if (minSteps <= 2 && (Math.abs(dy) <= step * 2 || Math.abs(dx) <= step * 2)) {
      forced = Math.min(forced, 1);
    }
  }
  if (forced === 0 && !pointInAnyObstacle(pin, obstacles, 1)) {
    return snap(pin, step);
  }
  let p = { ...pin };
  for (let i = 0; i < 48; i++) {
    p = stepDir(p, dir, step);
    const clear = !pointInAnyObstacle(p, obstacles, 1);
    if (i + 1 >= forced && clear) return snap(p, step);
  }
  return snap(p, step);
}

/**
 * Trunk occupancy. Use minLen=step to catch short vertical jogs that visually
 * merge into one spine; use a larger minLen for long horizontal bus detection.
 */
function occupiedTrunks(
  paths: Point[][],
  minLen: number,
): { xs: Set<number>; ys: Set<number> } {
  const xs = new Set<number>();
  const ys = new Set<number>();
  for (const path of paths) {
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      const len = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      if (len < minLen - 0.5) continue;
      if (Math.abs(a.x - b.x) < 0.5) xs.add(Math.round(a.x / GRID) * GRID);
      if (Math.abs(a.y - b.y) < 0.5) ys.add(Math.round(a.y / GRID) * GRID);
    }
  }
  return { xs, ys };
}

/**
 * Free coords strictly between lo and hi, nearest to `prefer` (or center)
 * first. Returns up to `count` so the caller can score real alternatives
 * instead of committing to the first free channel.
 */
function pickFreeChannels(
  lo: number,
  hi: number,
  used: Set<number>,
  step: number,
  prefer: number | undefined,
  count: number,
): number[] {
  const left = Math.min(lo, hi) + step;
  const right = Math.max(lo, hi) - step;
  if (right < left) return [];
  const mid =
    prefer != null
      ? Math.round(prefer / step) * step
      : Math.round(((lo + hi) / 2) / step) * step;
  const out: number[] = [];
  for (let k = 0; k < 48 && out.length < count; k++) {
    for (const sign of k === 0 ? [0] : ([1, -1] as const)) {
      const x = mid + sign * k * step;
      if (x < left - 0.5 || x > right + 0.5) continue;
      if (!used.has(x)) out.push(x);
      if (out.length >= count) break;
    }
  }
  return out;
}

/**
 * Rails scored per route; enough to find a clear lane (and to back off past a
 * reserved approach row, which can span half the neighbour's run), few enough
 * to stay cheap.
 */
const MAX_RAILS = 16;

/**
 * Rail coords to try for the single jog of a facing pair: grid lanes strictly
 * inside the gap, nearest to `prefer` first. Free lanes come before occupied
 * ones at equal distance; the scorer then decides whether sharing an occupied
 * lane (non-overlapping Y ranges) beats stepping next to a pin.
 */
function railCandidates(
  lo: number,
  hi: number,
  used: Set<number>,
  step: number,
  prefer: number,
): number[] {
  const near = pickFreeChannels(lo, hi, new Set<number>(), step, prefer, MAX_RAILS);
  // Free lanes win ties at equal distance from `prefer`.
  near.sort((a, b) => {
    const da = Math.abs(a - prefer);
    const db = Math.abs(b - prefer);
    if (Math.abs(da - db) > 0.5) return da - db;
    return (used.has(a) ? 1 : 0) - (used.has(b) ? 1 : 0);
  });
  // Always keep one clear lane in play, even when it sits outside the window.
  if (near.every((x) => used.has(x))) {
    const free = pickFreeChannels(lo, hi, used, step, prefer, 1);
    if (free.length) near.push(free[0]!);
  }
  return near;
}

type DirCode = 0 | 1 | 2 | 3 | 4;
const DIR_NONE = 4 as DirCode;
const DIR_CODES: RouteDir[] = ['N', 'E', 'S', 'W'];

function encodeDir(d: RouteDir | null): DirCode {
  if (!d) return DIR_NONE;
  const i = DIR_CODES.indexOf(d);
  return (i >= 0 ? i : DIR_NONE) as DirCode;
}

function decodeDir(c: DirCode): RouteDir | null {
  return c === DIR_NONE ? null : DIR_CODES[c]!;
}

/**
 * Discourages runs of `axis` orientation near `coord` — used to keep verticals
 * off a chip pin's escape column (the "stair right after the pin").
 * Cost is per grid cell, so a long run pays much more than a short jog.
 */
interface JogGuard {
  axis: Axis;
  coord: number;
  radius: number;
  cost: number;
}

function guardCost(guards: JogGuard[], axis: Axis, coord: number): number {
  let extra = 0;
  for (const g of guards) {
    if (g.axis !== axis) continue;
    if (Math.abs(coord - g.coord) <= g.radius + 0.5) extra += g.cost;
  }
  return extra;
}

function channelAStar(
  start: Point,
  goal: Point,
  obstacles: Aabb[],
  step: number,
  bendCost: number,
  overlapCost: number,
  trunks: { xs: Set<number>; ys: Set<number> },
  naturalYs: Set<number>,
  naturalXs: Set<number>,
  guards: JogGuard[] = [],
  hostBodies: Aabb[] = [],
): Point[] | null {
  const margin = step * 24;
  const minX = Math.floor((Math.min(start.x, goal.x) - margin) / step) * step;
  const maxX = Math.ceil((Math.max(start.x, goal.x) + margin) / step) * step;
  const minY = Math.floor((Math.min(start.y, goal.y) - margin) / step) * step;
  const maxY = Math.ceil((Math.max(start.y, goal.y) + margin) / step) * step;
  const cols = Math.floor((maxX - minX) / step) + 1;
  const rows = Math.floor((maxY - minY) / step) + 1;
  if (cols < 2 || rows < 2 || cols * rows > MAX_CELLS) return null;

  const blocked = new Uint8Array(cols * rows);
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const x = minX + ix * step;
      const y = minY + iy * step;
      if (pointInAnyObstacle({ x, y }, obstacles, 1)) {
        blocked[iy * cols + ix] = 1;
      }
    }
  }
  if (hostBodies.length) {
    for (let iy = 0; iy < rows; iy++) {
      for (let ix = 0; ix < cols; ix++) {
        const x = minX + ix * step;
        const y = minY + iy * step;
        if (pointInAnyObstacle({ x, y }, hostBodies, 1)) blocked[iy * cols + ix] = 1;
      }
    }
  }

  const clamp = (p: Point) => ({
    ix: Math.max(0, Math.min(cols - 1, Math.round((p.x - minX) / step))),
    iy: Math.max(0, Math.min(rows - 1, Math.round((p.y - minY) / step))),
  });
  const s = clamp(start);
  const g = clamp(goal);
  blocked[s.iy * cols + s.ix] = 0;
  blocked[g.iy * cols + g.ix] = 0;

  const stride = 5;
  const nState = cols * rows * stride;
  const gScore = new Float64Array(nState).fill(Infinity);
  const came = new Int32Array(nState).fill(-1);
  const stateKey = (ix: number, iy: number, d: DirCode) => (iy * cols + ix) * stride + d;
  const heur = (ix: number, iy: number) => Math.abs(g.ix - ix) + Math.abs(g.iy - iy);

  type Open = { ix: number; iy: number; d: DirCode; g: number; f: number };
  const open: Open[] = [];
  const startK = stateKey(s.ix, s.iy, DIR_NONE);
  gScore[startK] = 0;
  open.push({ ix: s.ix, iy: s.iy, d: DIR_NONE, g: 0, f: heur(s.ix, s.iy) });

  const neighborDeltas: [number, number, RouteDir][] = [
    [1, 0, 'E'],
    [-1, 0, 'W'],
    [0, 1, 'S'],
    [0, -1, 'N'],
  ];

  let bestGoalK = -1;
  let bestGoalG = Infinity;

  while (open.length) {
    let bestI = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i]!.f < open[bestI]!.f) bestI = i;
    }
    const cur = open.splice(bestI, 1)[0]!;
    const ck = stateKey(cur.ix, cur.iy, cur.d);
    if (cur.g > gScore[ck]! + 1e-9) continue;

    if (cur.ix === g.ix && cur.iy === g.iy) {
      if (cur.g < bestGoalG) {
        bestGoalG = cur.g;
        bestGoalK = ck;
      }
      let canBeat = false;
      for (const o of open) {
        if (o.f < bestGoalG - 1e-9) {
          canBeat = true;
          break;
        }
      }
      if (!canBeat) break;
      continue;
    }

    const prevDir = decodeDir(cur.d);
    for (const [dx, dy, nd] of neighborDeltas) {
      const nix = cur.ix + dx;
      const niy = cur.iy + dy;
      if (nix < 0 || niy < 0 || nix >= cols || niy >= rows) continue;
      if (blocked[niy * cols + nix]) continue;

      const ndCode = encodeDir(nd);
      const nk = stateKey(nix, niy, ndCode);
      let stepCost = 1;
      if (prevDir && prevDir !== nd) stepCost += bendCost;
      const wx = minX + nix * step;
      const wy = minY + niy * step;
      if (nd === 'N' || nd === 'S') {
        if (!naturalXs.has(wx) && trunks.xs.has(wx)) stepCost += overlapCost;
        stepCost += guardCost(guards, 'v', wx);
      } else {
        if (naturalYs.has(wy)) stepCost -= 0.35;
        else if (trunks.ys.has(wy)) stepCost += overlapCost;
        stepCost += guardCost(guards, 'h', wy);
      }

      const tent = cur.g + stepCost;
      if (tent >= gScore[nk]!) continue;
      came[nk] = ck;
      gScore[nk] = tent;
      open.push({ ix: nix, iy: niy, d: ndCode, g: tent, f: tent + heur(nix, niy) });
    }
  }

  if (bestGoalK < 0) return null;

  const cells: Point[] = [];
  let k = bestGoalK;
  while (k >= 0) {
    const cellIndex = Math.floor(k / stride);
    const ix = cellIndex % cols;
    const iy = (cellIndex / cols) | 0;
    cells.push({ x: minX + ix * step, y: minY + iy * step });
    k = came[k]!;
  }
  cells.reverse();
  return simplifyChannelPath([start, ...cells.slice(1, -1), goal]);
}

function pathUsesForeignChannel(
  path: Point[],
  trunks: { xs: Set<number>; ys: Set<number> },
  from: Point,
  to: Point,
  step: number,
  /** Prior polylines — a lane is only "taken" where their runs actually overlap. */
  others: Point[][] = [],
): boolean {
  const natYs = new Set([from.y, to.y].map((y) => Math.round(y / step) * step));
  const natXs = new Set([from.x, to.x].map((x) => Math.round(x / step) * step));
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const len = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    if (len < step - 0.5) continue;
    if (Math.abs(a.x - b.x) < 0.5) {
      const x = Math.round(a.x / step) * step;
      if (natXs.has(x) || !trunks.xs.has(x)) continue;
      // Runs may share a column when their Y ranges neither overlap nor touch
      // (typical after a chip drag leaves rows slightly misaligned).
      if (!verticalYOverlap(others, x, a.y, b.y, step)) continue;
      return true;
    }
    if (Math.abs(a.y - b.y) < 0.5) {
      const y = Math.round(a.y / step) * step;
      if (!natYs.has(y) && trunks.ys.has(y)) {
        if (!horizontalXOverlap(others, y, a.x, b.x, step)) continue;
        return true;
      }
    }
  }
  return false;
}

/**
 * Colinear runs on one lane count as merged when their ranges overlap *or
 * touch* (end-to-end runs read as one continuous line with a fake junction).
 * Runs at least half a grid apart stay visually distinct.
 */
function verticalYOverlap(
  paths: Point[][],
  x: number,
  y0: number,
  y1: number,
  step: number,
): boolean {
  const m = step * 0.5;
  const lo = Math.min(y0, y1);
  const hi = Math.max(y0, y1);
  for (const path of paths) {
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      if (Math.abs(a.x - b.x) >= 0.5) continue;
      if (Math.abs(a.x - x) >= step - 0.5) continue;
      const plo = Math.min(a.y, b.y);
      const phi = Math.max(a.y, b.y);
      if (lo < phi + m && hi > plo - m) return true;
    }
  }
  return false;
}

function horizontalXOverlap(
  paths: Point[][],
  y: number,
  x0: number,
  x1: number,
  step: number,
): boolean {
  const m = step * 0.5;
  const lo = Math.min(x0, x1);
  const hi = Math.max(x0, x1);
  for (const path of paths) {
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      if (Math.abs(a.y - b.y) >= 0.5) continue;
      if (Math.abs(a.y - y) >= step - 0.5) continue;
      const plo = Math.min(a.x, b.x);
      const phi = Math.max(a.x, b.x);
      if (lo < phi + m && hi > plo - m) return true;
    }
  }
  return false;
}

/** True when `p` lies on (not just at the end of) a segment of any prior path. */
function pointOnForeignSegment(p: Point, paths: Point[][]): boolean {
  for (const path of paths) {
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      if (Math.abs(a.x - b.x) < 0.5) {
        if (Math.abs(p.x - a.x) >= 0.5) continue;
        if (p.y > Math.min(a.y, b.y) + 0.5 && p.y < Math.max(a.y, b.y) - 0.5) return true;
      } else if (Math.abs(a.y - b.y) < 0.5) {
        if (Math.abs(p.y - a.y) >= 0.5) continue;
        if (p.x > Math.min(a.x, b.x) + 0.5 && p.x < Math.max(a.x, b.x) - 0.5) return true;
      }
    }
  }
  return false;
}

/**
 * Clearance a jog must keep from a pin. Capped at half the gap so short hops
 * (facing pins two grid apart) can still bend in the middle.
 */
function jogClearance(gap: number, step: number): number {
  return Math.min(step * 2.5, Math.max(0, gap / 2 - step * 0.5));
}

function clampTo(v: number, a: number, b: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), v));
}

/**
 * Cost of a jog that sits `dist` from the pin it just left, where `clear` is
 * the clearance the gap can afford. Always heavier than a colinear overlap
 * (`OVERLAP_BASE + len`) so a congested gap shares a lane instead of stepping
 * right next to the pin — that step is the "stair after the pin" users report.
 * Graded by distance so the least-bad lane still wins among stairs.
 */
function stairPenalty(dist: number, clear: number, step: number, len: number): number {
  if (dist < step * 0.5) return 300 + len;
  if (dist > clear + 0.5) return 0;
  return 100 + 8 * (clear - dist) + len;
}

/**
 * Colinear overlap with a foreign wire: `OVERLAP_BASE + len`. Sits above the
 * destination-column hug (120) for any run longer than 4 grid, so a wire
 * would rather slide along the chip edge than merge into a neighbour.
 */
const OVERLAP_BASE = 80;
/** Penalty per vertex that sits behind a pin (on its body side). */
const BEHIND_PIN_PENALTY = 150;
/** Penalty per corner that lands on a foreign wire (reads as a T junction). */
const FAKE_TEE_PENALTY = 50;
/**
 * Per-pixel cost for running along a later wire's pin approach lane. Milder
 * than a stair (100+) so a wire still jogs early rather than next to its pin.
 */
const RESERVED_LANE_COST = 0.6;

interface ScoreCtx {
  from: Point;
  to: Point;
  step: number;
  startAxis: Axis;
  endAxis: Axis;
  /** Exit deltas; zero when the target lies behind the pin (detour is legit). */
  startDelta: [number, number];
  endDelta: [number, number];
  srcClearX: number;
  srcClearY: number;
  usedXs: Set<number>;
  usedYs: Set<number>;
  others: Point[][];
  reserved: RouteLane[];
}

function makeScoreCtx(
  from: Point,
  to: Point,
  step: number,
  startDir: RouteDir | null | undefined,
  endDir: RouteDir | null | undefined,
  usedXs: Set<number>,
  usedYs: Set<number>,
  others: Point[][],
  reserved: RouteLane[],
): ScoreCtx {
  const adx = Math.abs(from.x - to.x);
  const ady = Math.abs(from.y - to.y);
  const spanAxis: Axis = adx >= ady ? 'h' : 'v';
  const none: [number, number] = [0, 0];
  return {
    from,
    to,
    step,
    startAxis: dirAxis(startDir) ?? spanAxis,
    endAxis: dirAxis(endDir) ?? spanAxis,
    startPinned: !!startDir,
    endPinned: !!endDir,
    startDelta: startDir && isAhead(from, to, startDir, step) ? dirDelta(startDir) : none,
    endDelta: endDir && isAhead(to, from, endDir, step) ? dirDelta(endDir) : none,
    srcClearX: jogClearance(adx, step),
    srcClearY: jogClearance(ady, step),
    usedXs,
    usedYs,
    others,
    reserved,
  };
}

/** Length of an axis-aligned run [lo, hi] on `coord` that lies inside reserved lanes. */
function reservedOverlap(
  lanes: RouteLane[],
  axis: Axis,
  coord: number,
  lo: number,
  hi: number,
): number {
  let total = 0;
  for (const lane of lanes) {
    if (lane.axis !== axis || Math.abs(lane.coord - coord) >= 0.5) continue;
    total += Math.max(0, Math.min(hi, lane.hi) - Math.max(lo, lane.lo));
  }
  return total;
}

/**
 * Shared badness metric: bends + length plus the artifacts users report —
 * a jog on a pin's own escape lane, a long run sliding along a pin column,
 * backtracking away from the target, and collapsing onto a foreign trunk.
 */
function scorePath(c: Point[], ctx: ScoreCtx): number {
  const { from, to, step, startDelta, endDelta } = ctx;
  const travelX = Math.sign(to.x - from.x);
  const travelY = Math.sign(to.y - from.y);
  let score = bendCount(c) * 20 + pathLen(c);
  for (let i = 0; i < c.length - 1; i++) {
    const a = c[i]!;
    const b = c[i + 1]!;
    const len = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    if (len < step - 0.5) continue;
    if (Math.abs(a.x - b.x) < 0.5) {
      const x = Math.round(a.x / step) * step;
      // Exit stair: vertical jog on/next to an E/W pin's own column.
      if (ctx.startPinned && ctx.startAxis === 'h') {
        score += stairPenalty(Math.abs(x - from.x), ctx.srcClearX, step, len);
      }
      // Long vertical sliding along the destination pin column.
      if (ctx.endPinned && ctx.endAxis === 'h' && Math.abs(x - to.x) <= step * 1.5 && len > step * 3) {
        score += 120;
      }
      // Colinear overlap with an existing wire — reads as one merged line.
      if (ctx.usedXs.has(x) && verticalYOverlap(ctx.others, x, a.y, b.y, step)) {
        score += OVERLAP_BASE + len;
      }
      if (travelY !== 0 && Math.sign(b.y - a.y) !== travelY) score += 40;
      score +=
        RESERVED_LANE_COST *
        reservedOverlap(ctx.reserved, 'v', a.x, Math.min(a.y, b.y), Math.max(a.y, b.y));
    } else {
      const y = Math.round(a.y / step) * step;
      if (ctx.startAxis === 'v') {
        score += stairPenalty(Math.abs(y - from.y), ctx.srcClearY, step, len);
      }
      if (ctx.endAxis === 'v' && Math.abs(y - to.y) <= step * 1.5 && len > step * 3) score += 120;
      if (ctx.usedYs.has(y) && horizontalXOverlap(ctx.others, y, a.x, b.x, step)) {
        score += OVERLAP_BASE + len;
      }
      if (travelX !== 0 && Math.sign(b.x - a.x) !== travelX) score += 40;
      score +=
        RESERVED_LANE_COST *
        reservedOverlap(ctx.reserved, 'h', a.y, Math.min(a.x, b.x), Math.max(a.x, b.x));
    }
  }
  for (let i = 1; i < c.length - 1; i++) {
    const p = c[i]!;
    // Looping behind either pin (U back toward the source, or past the
    // destination into its package side) is worse than sharing a lane.
    if ((p.x - from.x) * startDelta[0] + (p.y - from.y) * startDelta[1] < -0.5) {
      score += BEHIND_PIN_PENALTY;
    }
    if ((p.x - to.x) * endDelta[0] + (p.y - to.y) * endDelta[1] < -0.5) {
      score += BEHIND_PIN_PENALTY;
    }
    // A corner sitting on a foreign wire reads as a junction.
    if (pointOnForeignSegment(p, ctx.others)) score += FAKE_TEE_PENALTY;
  }
  return score;
}

/**
 * Pin→pin candidate shapes, chosen by the *pin exit axes* rather than by the
 * span aspect: a wire leaving an E/W pin must start horizontal, so a vertical
 * jog on (or next to) the pin's own column is never a candidate. That jog is
 * the "stair right after the pin" users see after dragging a chip.
 * Preferred shape for facing pins: start row → vertical near the destination
 * approach → into the pin.
 */
function trySimpleFacing(
  from: Point,
  to: Point,
  escA: Point,
  escB: Point,
  obstacles: Aabb[],
  hosts: Aabb[],
  step: number,
  ctx: ScoreCtx,
  startDir: RouteDir | null | undefined,
  endDir: RouteDir | null | undefined,
): Point[] | null {
  const candidates: Point[][] = [];
  const adx = Math.abs(from.x - to.x);
  const ady = Math.abs(from.y - to.y);
  const { startAxis, endAxis, srcClearX, srcClearY, usedXs, usedYs } = ctx;
  const startAhead = isAhead(from, to, startDir, step);
  const endAhead = isAhead(to, from, endDir, step);

  const colinear =
    (startAxis === 'h' && endAxis === 'h' && ady < 0.5) ||
    (startAxis === 'v' && endAxis === 'v' && adx < 0.5);

  if (colinear) {
    candidates.push(simplifyChannelPath([from, to]));
  } else if (startAxis === 'h' && endAxis === 'h' && startAhead && endAhead) {
    // Facing E↔W pair: single vertical rail somewhere in the gap.
    const sign = Math.sign(to.x - from.x) || 1;
    const destJogX = to.x - sign * step;
    const clearJogX = from.x + sign * (srcClearX + step);

    // Small dy: rail right at the destination approach (one tight jog).
    if (ady <= step * 4) {
      const rail = Math.round(escB.x / step) * step;
      candidates.push(simplifyChannelPath([from, { x: rail, y: from.y }, { x: rail, y: to.y }, to]));
    }
    // Packages (almost) touching: no grid lane fits between the pins, so jog
    // in the middle of the gap instead of looping back around a body.
    if (adx < step * 2 && ady > 0.5) {
      const rail = (from.x + to.x) / 2;
      candidates.push(simplifyChannelPath([from, { x: rail, y: from.y }, { x: rail, y: to.y }, to]));
    }
    // Long verticals (fan-in): spread them over free columns, starting from
    // the gap centre. The band reaches back toward the source pin so a
    // congested gap degrades into a closer column (scored) instead of a detour.
    const prefer =
      ady <= step * 4
        ? destJogX
        : clampTo(Math.round(((from.x + to.x) / 2) / step) * step, clearJogX, destJogX);
    const lanesX = railCandidates(from.x, destJogX + sign * step, usedXs, step, prefer);
    for (const railX of lanesX) {
      candidates.push(
        simplifyChannelPath([from, { x: railX, y: from.y }, { x: railX, y: to.y }, to]),
      );
    }
    candidates.push(simplifyChannelPath([from, { x: escB.x, y: from.y }, escB, to]));
  } else if (startAxis === 'v' && endAxis === 'v' && startAhead && endAhead) {
    // Facing N↕S pair: mirror of the above (single horizontal rail).
    const sign = Math.sign(to.y - from.y) || 1;
    const destJogY = to.y - sign * step;
    const clearJogY = from.y + sign * (srcClearY + step);

    if (adx <= step * 4) {
      const rail = Math.round(escB.y / step) * step;
      candidates.push(simplifyChannelPath([from, { x: from.x, y: rail }, { x: to.x, y: rail }, to]));
    }
    if (ady < step * 2 && adx > 0.5) {
      const rail = (from.y + to.y) / 2;
      candidates.push(simplifyChannelPath([from, { x: from.x, y: rail }, { x: to.x, y: rail }, to]));
    }
    const prefer =
      adx <= step * 4
        ? destJogY
        : clampTo(Math.round(((from.y + to.y) / 2) / step) * step, clearJogY, destJogY);
    for (const railY of railCandidates(from.y, destJogY + sign * step, usedYs, step, prefer)) {
      candidates.push(
        simplifyChannelPath([from, { x: from.x, y: railY }, { x: to.x, y: railY }, to]),
      );
    }
    candidates.push(simplifyChannelPath([from, { x: from.x, y: escB.y }, escB, to]));
  } else if (startAxis !== endAxis && startAhead && endAhead) {
    // Perpendicular pins: one bend when the corner clears the source pin,
    // otherwise a double jog that still leaves/enters along the pin axes.
    if (startAxis === 'h') {
      if (adx >= srcClearX + step - 0.5) {
        candidates.push(simplifyChannelPath([from, { x: to.x, y: from.y }, to]));
      }
      candidates.push(
        simplifyChannelPath([from, escA, { x: escA.x, y: escB.y }, escB, to]),
      );
    } else {
      if (ady >= srcClearY + step - 0.5) {
        candidates.push(simplifyChannelPath([from, { x: from.x, y: to.y }, to]));
      }
      candidates.push(
        simplifyChannelPath([from, escA, { x: escB.x, y: escA.y }, escB, to]),
      );
    }
  }

  let best: Point[] | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    if (c.length < 2 || pathHitsInterior(c, obstacles)) continue;
    if (pathCrossesHost(c, hosts, startDir, endDir)) continue;
    const score = scorePath(c, ctx);
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

function bendCount(pts: Point[]): number {
  return Math.max(0, pts.length - 2);
}

function pathLen(pts: Point[]): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += manhattan(pts[i - 1]!, pts[i]!);
  return n;
}

/**
 * Escape → channel A* → pin stubs.
 * Prefers a simple facing path on a *free* mid channel so ribbons don't
 * collapse onto one shared escape column.
 */
export function routeEscapeChannel(req: ChannelRouteRequest): Point[] {
  const step = req.grid ?? GRID;
  const bendCost = req.bendCost ?? DEFAULT_BEND;
  const overlapCost = req.overlapCost ?? DEFAULT_OVERLAP;
  const { from, to, obstacles } = req;

  if (manhattan(from, to) < 0.5) return [from];

  const hostBodies = req.hostObstacles ?? [];
  const escapeBoxes = hostBodies.length ? [...obstacles, ...hostBodies] : obstacles;
  // Source escape is up to 3 grid long so the maze can never turn next to the
  // pin — capped at half the gap so a tight pair does not escape *past* the
  // destination column and come back.
  const srcSteps = Math.max(1, Math.min(3, Math.floor(gapAlong(from, to, req.startDir) / step / 2)));
  const escA = escapePoint(from, req.startDir, escapeBoxes, step, srcSteps, to);
  const escB = escapePoint(to, req.endDir, escapeBoxes, step, 2, from);

  const channelTrunks = occupiedTrunks(req.avoidOverlap ?? [], step);
  const longTrunks = occupiedTrunks(req.avoidOverlap ?? [], step * 3);

  const scoreCtx = makeScoreCtx(
    from,
    to,
    step,
    req.startDir,
    req.endDir,
    channelTrunks.xs,
    channelTrunks.ys,
    req.avoidOverlap ?? [],
    req.reservedLanes ?? [],
  );
  const simple = trySimpleFacing(
    from,
    to,
    escA,
    escB,
    obstacles,
    hostBodies,
    step,
    scoreCtx,
    req.startDir,
    req.endDir,
  );
  if (
    simple &&
    !pathUsesForeignChannel(simple, channelTrunks, from, to, step, req.avoidOverlap ?? [])
  ) {
    return simple;
  }

  const naturalYs = new Set([from.y, to.y].map((y) => Math.round(y / step) * step));
  const naturalXs = new Set([from.x, to.x].map((x) => Math.round(x / step) * step));

  // Keep the maze off the pin escape lanes: heavy per-cell cost for turning
  // across the source pin's own column/row, mild cost for sliding along the
  // destination pin's (a short approach jog stays cheap, a long run does not).
  const startAxis = dirAxis(req.startDir);
  const endAxis = dirAxis(req.endDir);
  const guards: JogGuard[] = [];
  if (startAxis === 'h') {
    guards.push({
      axis: 'v',
      coord: from.x,
      radius: jogClearance(Math.abs(to.x - from.x), step),
      cost: 30,
    });
  } else if (startAxis === 'v') {
    guards.push({
      axis: 'h',
      coord: from.y,
      radius: jogClearance(Math.abs(to.y - from.y), step),
      cost: 30,
    });
  }
  if (endAxis === 'h') {
    guards.push({ axis: 'v', coord: to.x, radius: step * 1.2, cost: 1.5 });
  } else if (endAxis === 'v') {
    guards.push({ axis: 'h', coord: to.y, radius: step * 1.2, cost: 1.5 });
  }

  let mid = channelAStar(
    escA,
    escB,
    obstacles,
    step,
    bendCost,
    overlapCost,
    { xs: new Set([...channelTrunks.xs, ...longTrunks.xs]), ys: longTrunks.ys },
    naturalYs,
    naturalXs,
    guards,
    hostBodies,
  );
  if (!mid) {
    mid =
      Math.abs(escA.x - escB.x) < 0.5 || Math.abs(escA.y - escB.y) < 0.5
        ? [escA, escB]
        : [escA, { x: escB.x, y: escA.y }, escB];
  }

  const mazed = simplifyChannelPath([from, ...mid, to]);
  // The simple shape was only set aside because it shares a channel; that is
  // often milder than the detour the maze takes to dodge the trunk, so let the
  // shared metric decide instead of rejecting outright (ties go to the simple
  // shape — its lane choice is the deliberate one).
  if (simple && scorePath(simple, scoreCtx) <= scorePath(mazed, scoreCtx)) return simple;
  return mazed;
}
