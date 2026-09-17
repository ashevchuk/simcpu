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
  /** Foreign polylines — colinear overlap reads as one merged line. */
  avoidOverlap?: Point[][];
  /** Polylines whose H×V crossings cost a little (well below a stair). */
  avoidCrossings?: Point[][];
  /**
   * Same-net polylines — running colinear along them is rewarded (shared bus
   * spine) and never counts as overlap or crossing.
   */
  preferAlong?: Point[][];
  /** Approach rows/columns of wires that will be routed after this one. */
  reservedLanes?: RouteLane[];
  /**
   * Rail coordinate (x for an E↔W pair, y for N↕S) picked for this wire as
   * part of a ribbon. Tried first; the scorer may still reject it.
   */
  preferRail?: number;
  grid?: number;
  bendCost?: number;
  overlapCost?: number;
}

const DEFAULT_BEND = 2.5;
const DEFAULT_OVERLAP = 8;
const MAX_CELLS = 40_000;

/**
 * Prior polylines indexed by lane so overlap / tee / crossing checks touch
 * only the runs on the coordinate in question instead of every prior path.
 * Keys are grid-rounded coords; `runsNear` widens to neighbouring keys so
 * off-grid pins (chip stacks at x=116) still match within `tol`.
 */
interface Run {
  coord: number;
  lo: number;
  hi: number;
}

export interface SegIndex {
  vert: Map<number, Run[]>;
  horiz: Map<number, Run[]>;
  vertAll: Run[];
  horizAll: Run[];
  step: number;
}

function buildSegIndex(paths: Point[][], step: number): SegIndex {
  const idx: SegIndex = { vert: new Map(), horiz: new Map(), vertAll: [], horizAll: [], step };
  const add = (map: Map<number, Run[]>, all: Run[], run: Run) => {
    const key = Math.round(run.coord / step) * step;
    const list = map.get(key);
    if (list) list.push(run);
    else map.set(key, [run]);
    all.push(run);
  };
  for (const path of paths) {
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      if (Math.abs(a.x - b.x) < 0.5) {
        if (Math.abs(a.y - b.y) < 0.5) continue;
        add(idx.vert, idx.vertAll, { coord: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) });
      } else if (Math.abs(a.y - b.y) < 0.5) {
        add(idx.horiz, idx.horizAll, { coord: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) });
      }
    }
  }
  return idx;
}

const EMPTY_RUNS: Run[] = [];

/** Runs whose coordinate lies within `tol` of `coord` (tol ≤ step). */
function runsNear(map: Map<number, Run[]>, coord: number, step: number, tol: number): Run[] {
  const key = Math.round(coord / step) * step;
  let out: Run[] | null = null;
  for (const k of [key - step, key, key + step]) {
    const list = map.get(k);
    if (!list) continue;
    for (const r of list) {
      if (Math.abs(r.coord - coord) < tol) (out ??= []).push(r);
    }
  }
  return out ?? EMPTY_RUNS;
}

function pathBounds(path: Point[]): Aabb {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of path) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Keep only paths whose bounding box touches `box` — the rest cannot interact with this route. */
function cullPaths(paths: Point[][], box: Aabb): Point[][] {
  const out: Point[][] = [];
  for (const path of paths) {
    if (path.length < 2) continue;
    const b = pathBounds(path);
    if (b.maxX < box.minX || b.minX > box.maxX || b.maxY < box.minY || b.minY > box.maxY) continue;
    out.push(path);
  }
  return out;
}

function samePolyline(a: Point[], b: Point[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i]!.x - b[i]!.x) >= 0.5 || Math.abs(a[i]!.y - b[i]!.y) >= 0.5) return false;
  }
  return true;
}

/** Drop the same-net polylines (by reference, then by geometry) from `paths`. */
function withoutSameNet(paths: Point[][], sameNet: Point[][]): Point[][] {
  if (!sameNet.length) return paths;
  const refs = new Set(sameNet);
  return paths.filter((p) => !refs.has(p) && !sameNet.some((s) => samePolyline(s, p)));
}

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

type Open = { ix: number; iy: number; d: DirCode; g: number; f: number; seq: number };

/**
 * Binary min-heap on (f, seq). FIFO among equal f reproduces the order the
 * previous linear min-scan expanded nodes in, so routes stay bit-identical.
 */
class OpenHeap {
  private items: Open[] = [];

  get size(): number {
    return this.items.length;
  }

  peek(): Open | undefined {
    return this.items[0];
  }

  private less(a: Open, b: Open): boolean {
    return a.f < b.f || (a.f === b.f && a.seq < b.seq);
  }

  push(o: Open): void {
    const items = this.items;
    items.push(o);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(items[i]!, items[parent]!)) break;
      [items[i], items[parent]] = [items[parent]!, items[i]!];
      i = parent;
    }
  }

  pop(): Open | undefined {
    const items = this.items;
    if (!items.length) return undefined;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length) {
      items[0] = last;
      let i = 0;
      const n = items.length;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < n && this.less(items[l]!, items[m]!)) m = l;
        if (r < n && this.less(items[r]!, items[m]!)) m = r;
        if (m === i) break;
        [items[i], items[m]] = [items[m]!, items[i]!];
        i = m;
      }
    }
    return top;
  }
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

  const open = new OpenHeap();
  let seq = 0;
  const startK = stateKey(s.ix, s.iy, DIR_NONE);
  gScore[startK] = 0;
  open.push({ ix: s.ix, iy: s.iy, d: DIR_NONE, g: 0, f: heur(s.ix, s.iy), seq: seq++ });

  const neighborDeltas: [number, number, RouteDir][] = [
    [1, 0, 'E'],
    [-1, 0, 'W'],
    [0, 1, 'S'],
    [0, -1, 'N'],
  ];

  let bestGoalK = -1;
  let bestGoalG = Infinity;

  while (open.size) {
    const cur = open.pop()!;
    const ck = stateKey(cur.ix, cur.iy, cur.d);
    if (cur.g > gScore[ck]! + 1e-9) continue;

    if (cur.ix === g.ix && cur.iy === g.iy) {
      if (cur.g < bestGoalG) {
        bestGoalG = cur.g;
        bestGoalK = ck;
      }
      // Heap top is the best remaining f; nothing left can beat the goal.
      const next = open.peek();
      if (!next || next.f >= bestGoalG - 1e-9) break;
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
      open.push({ ix: nix, iy: niy, d: ndCode, g: tent, f: tent + heur(nix, niy), seq: seq++ });
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
  others: SegIndex,
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
  others: SegIndex,
  x: number,
  y0: number,
  y1: number,
  step: number,
): boolean {
  const m = step * 0.5;
  const lo = Math.min(y0, y1);
  const hi = Math.max(y0, y1);
  for (const r of runsNear(others.vert, x, others.step, step - 0.5)) {
    if (lo < r.hi + m && hi > r.lo - m) return true;
  }
  return false;
}

function horizontalXOverlap(
  others: SegIndex,
  y: number,
  x0: number,
  x1: number,
  step: number,
): boolean {
  const m = step * 0.5;
  const lo = Math.min(x0, x1);
  const hi = Math.max(x0, x1);
  for (const r of runsNear(others.horiz, y, others.step, step - 0.5)) {
    if (lo < r.hi + m && hi > r.lo - m) return true;
  }
  return false;
}

/** True when `p` lies on (not just at the end of) a segment of any prior path. */
function pointOnForeignSegment(p: Point, others: SegIndex): boolean {
  for (const r of runsNear(others.vert, p.x, others.step, 0.5)) {
    if (p.y > r.lo + 0.5 && p.y < r.hi - 0.5) return true;
  }
  for (const r of runsNear(others.horiz, p.y, others.step, 0.5)) {
    if (p.x > r.lo + 0.5 && p.x < r.hi - 0.5) return true;
  }
  return false;
}

/** H×V crossings of one axis-aligned segment with the indexed runs. */
function segmentCrossings(a: Point, b: Point, others: SegIndex): number {
  let n = 0;
  if (Math.abs(a.x - b.x) < 0.5) {
    const lo = Math.min(a.y, b.y);
    const hi = Math.max(a.y, b.y);
    for (const r of others.horizAll) {
      if (r.coord > lo + 0.5 && r.coord < hi - 0.5 && a.x > r.lo + 0.5 && a.x < r.hi - 0.5) n++;
    }
  } else if (Math.abs(a.y - b.y) < 0.5) {
    const lo = Math.min(a.x, b.x);
    const hi = Math.max(a.x, b.x);
    for (const r of others.vertAll) {
      if (r.coord > lo + 0.5 && r.coord < hi - 0.5 && a.y > r.lo + 0.5 && a.y < r.hi - 0.5) n++;
    }
  }
  return n;
}

/** Colinear length of one segment shared with the indexed (same-net) runs. */
function segmentAlongLength(a: Point, b: Point, along: SegIndex): number {
  let total = 0;
  if (Math.abs(a.x - b.x) < 0.5) {
    const lo = Math.min(a.y, b.y);
    const hi = Math.max(a.y, b.y);
    for (const r of runsNear(along.vert, a.x, along.step, 0.5)) {
      total += Math.max(0, Math.min(hi, r.hi) - Math.max(lo, r.lo));
    }
  } else if (Math.abs(a.y - b.y) < 0.5) {
    const lo = Math.min(a.x, b.x);
    const hi = Math.max(a.x, b.x);
    for (const r of runsNear(along.horiz, a.y, along.step, 0.5)) {
      total += Math.max(0, Math.min(hi, r.hi) - Math.max(lo, r.lo));
    }
  }
  return total;
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
export const OVERLAP_BASE = 80;
/** Penalty per vertex that sits behind a pin (on its body side). */
const BEHIND_PIN_PENALTY = 150;
/** Penalty per corner that lands on a foreign wire (reads as a T junction). */
const FAKE_TEE_PENALTY = 50;
/**
 * Per-pixel cost for running along a later wire's pin approach lane. Milder
 * than a stair (100+) so a wire still jogs early rather than next to its pin.
 */
const RESERVED_LANE_COST = 0.6;
/** Per H×V crossing of a foreign wire — mild, well below a stair (100+). */
const CROSSING_PENALTY = 15;
/**
 * Per-pixel reward for running colinear with a same-net wire (bus spine).
 * Below the 1/px length cost so a wire never detours to share a spine.
 */
const ALONG_BONUS = 0.3;

interface ScoreCtx {
  from: Point;
  to: Point;
  step: number;
  startAxis: Axis;
  endAxis: Axis;
  startPinned: boolean;
  endPinned: boolean;
  /** Exit deltas; zero when the target lies behind the pin (detour is legit). */
  startDelta: [number, number];
  endDelta: [number, number];
  srcClearX: number;
  srcClearY: number;
  usedXs: Set<number>;
  usedYs: Set<number>;
  /** Foreign (not same-net) polylines whose colinear overlap is penalized. */
  others: SegIndex;
  /** Foreign polylines whose H×V crossings are penalized. */
  crossings: SegIndex | null;
  /** Same-net polylines rewarded for colinear runs. */
  along: SegIndex | null;
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
  others: SegIndex,
  reserved: RouteLane[],
  crossings: SegIndex | null = null,
  along: SegIndex | null = null,
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
    crossings,
    along,
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
    if (ctx.crossings) score += CROSSING_PENALTY * segmentCrossings(a, b, ctx.crossings);
    if (ctx.along) score -= ALONG_BONUS * segmentAlongLength(a, b, ctx.along);
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
  preferRail?: number,
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

    // Ribbon rail assigned by the caller goes first so it wins score ties.
    if (preferRail != null && (preferRail - from.x) * sign > 0.5 && (to.x - preferRail) * sign > 0.5) {
      candidates.push(
        simplifyChannelPath([from, { x: preferRail, y: from.y }, { x: preferRail, y: to.y }, to]),
      );
    }
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

    if (preferRail != null && (preferRail - from.y) * sign > 0.5 && (to.y - preferRail) * sign > 0.5) {
      candidates.push(
        simplifyChannelPath([from, { x: from.x, y: preferRail }, { x: to.x, y: preferRail }, to]),
      );
    }
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
interface RouteCtx {
  step: number;
  hostBodies: Aabb[];
  escA: Point;
  escB: Point;
  /** Foreign prior paths within reach of this route. */
  foreign: Point[][];
  foreignIndex: SegIndex;
  channelTrunks: { xs: Set<number>; ys: Set<number> };
  longTrunks: { xs: Set<number>; ys: Set<number> };
  scoreCtx: ScoreCtx;
}

/**
 * Per-route setup shared by the router and the re-scorer: escape points,
 * prior paths culled to the search window, same-net paths split off, and the
 * lane indexes the scorer reads.
 */
function makeRouteCtx(req: ChannelRouteRequest): RouteCtx {
  const step = req.grid ?? GRID;
  const { from, to, obstacles } = req;
  const hostBodies = req.hostObstacles ?? [];
  const escapeBoxes = hostBodies.length ? [...obstacles, ...hostBodies] : obstacles;
  // Source escape is up to 3 grid long so the maze can never turn next to the
  // pin — capped at half the gap so a tight pair does not escape *past* the
  // destination column and come back.
  const srcSteps = Math.max(1, Math.min(3, Math.floor(gapAlong(from, to, req.startDir) / step / 2)));
  const escA = escapePoint(from, req.startDir, escapeBoxes, step, srcSteps, to);
  const escB = escapePoint(to, req.endDir, escapeBoxes, step, 2, from);

  // Anything outside the maze window (+1 grid) cannot touch a candidate.
  const margin = step * 25;
  const window = pathBounds([from, to, escA, escB]);
  window.minX -= margin;
  window.minY -= margin;
  window.maxX += margin;
  window.maxY += margin;

  const sameNet = cullPaths(req.preferAlong ?? [], window);
  const foreign = withoutSameNet(cullPaths(req.avoidOverlap ?? [], window), sameNet);
  const crossing = req.avoidCrossings?.length
    ? withoutSameNet(cullPaths(req.avoidCrossings, window), sameNet)
    : [];

  const channelTrunks = occupiedTrunks(foreign, step);
  const longTrunks = occupiedTrunks(foreign, step * 3);
  const foreignIndex = buildSegIndex(foreign, step);
  const scoreCtx = makeScoreCtx(
    from,
    to,
    step,
    req.startDir,
    req.endDir,
    channelTrunks.xs,
    channelTrunks.ys,
    foreignIndex,
    req.reservedLanes ?? [],
    crossing.length ? buildSegIndex(crossing, step) : null,
    sameNet.length ? buildSegIndex(sameNet, step) : null,
  );
  return { step, hostBodies, escA, escB, foreign, foreignIndex, channelTrunks, longTrunks, scoreCtx };
}

/**
 * Badness of `path` for `req` beyond its bare bends + length: stairs, pin
 * hugs, overlap, U-turns, crossings (minus the same-net spine bonus). Used by
 * the tidy rip-up pass to spot wires worth a second try.
 */
export function channelRoutePenalty(req: ChannelRouteRequest, path: Point[]): number {
  if (path.length < 2) return 0;
  const { scoreCtx } = makeRouteCtx(req);
  return scorePath(path, scoreCtx) - (bendCount(path) * 20 + pathLen(path));
}

export function routeEscapeChannel(req: ChannelRouteRequest): Point[] {
  const bendCost = req.bendCost ?? DEFAULT_BEND;
  const overlapCost = req.overlapCost ?? DEFAULT_OVERLAP;
  const { from, to, obstacles } = req;

  if (manhattan(from, to) < 0.5) return [from];

  const { step, hostBodies, escA, escB, foreignIndex, channelTrunks, longTrunks, scoreCtx } =
    makeRouteCtx(req);

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
    req.preferRail,
  );
  if (simple && !pathUsesForeignChannel(simple, channelTrunks, from, to, step, foreignIndex)) {
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

/** One wire of a facing ribbon, described across the gap axis. */
export interface RibbonWire {
  id: string;
  /** Pin coordinate across the gap on the source side (y for an E↔W ribbon). */
  src: number;
  /** Pin coordinate across the gap on the destination side. */
  dst: number;
}

export interface RibbonRailOpts {
  step?: number;
  /** Lane coords already carrying a frozen trunk through this band. */
  used?: Set<number>;
}

/** Grid coords strictly inside (a, b), ordered from `a` toward `b`. */
function gridLanesBetween(a: number, b: number, step: number): number[] {
  const sign = Math.sign(b - a) || 1;
  const lo = Math.min(a, b) + step;
  const hi = Math.max(a, b) - step;
  const out: number[] = [];
  for (let k = Math.ceil((lo - 0.5) / step); k * step <= hi + 0.5; k++) out.push(k * step);
  return sign > 0 ? out : out.reverse();
}

/**
 * Rails for a facing ribbon — one single-jog lane per wire between the two
 * pin rows/columns, ordered so no two wires braid.
 *
 * With rails x_i < x_j (i nearer the source) the only possible conflicts are
 * j's source row cutting i's vertical, or i's destination row cutting j's
 * vertical (a shared row end-to-end reads as one merged line, so touching
 * counts too). That gives a precedence between every pair; a topological
 * order over the forced pairs is crossing-free whenever one exists.
 *
 * Wires get a contiguous block of lanes: at the destination side when the
 * ribbon shifts by ≤ 3 grid (one tight jog), else centred in the gap and kept
 * clear of the source pins. When there are more wires than lanes (tight gap)
 * lanes are shared in order by wires whose spans do not touch.
 */
export function assignRibbonRails(
  wires: RibbonWire[],
  gapFrom: number,
  gapTo: number,
  opts: RibbonRailOpts = {},
): Map<string, number> {
  const step = opts.step ?? GRID;
  const out = new Map<string, number>();
  const n = wires.length;
  if (n === 0) return out;
  const lanes = gridLanesBetween(gapFrom, gapTo, step);
  if (!lanes.length) return out;

  const tol = 0.5;
  const span = (w: RibbonWire): [number, number] => [Math.min(w.src, w.dst), Math.max(w.src, w.dst)];
  /** True when `i` cannot sit nearer the source than `j`. */
  const conflict = (i: number, j: number): boolean => {
    const wi = wires[i]!;
    const wj = wires[j]!;
    const [loI, hiI] = span(wi);
    const [loJ, hiJ] = span(wj);
    // Same source pin (fan-out) or same destination pin (fan-in) share a row legitimately.
    if (Math.abs(wj.src - wi.src) > tol && wj.src >= loI - tol && wj.src <= hiI + tol) return true;
    if (Math.abs(wi.dst - wj.dst) > tol && wi.dst >= loJ - tol && wi.dst <= hiJ + tol) return true;
    return false;
  };

  // Kahn's algorithm over forced precedences; ties (and cycles) fall back to
  // source-coordinate order so the result is deterministic.
  const indeg = new Array<number>(n).fill(0);
  const succ: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ij = conflict(i, j);
      const ji = conflict(j, i);
      if (ij && !ji) {
        succ[j]!.push(i);
        indeg[i]!++;
      } else if (ji && !ij) {
        succ[i]!.push(j);
        indeg[j]!++;
      }
    }
  }
  const bySrc = (a: number, b: number) => wires[a]!.src - wires[b]!.src || a - b;
  const order: number[] = [];
  const done = new Array<boolean>(n).fill(false);
  while (order.length < n) {
    const ready: number[] = [];
    for (let i = 0; i < n; i++) if (!done[i] && indeg[i] === 0) ready.push(i);
    if (!ready.length) {
      // Braid: no crossing-free order exists; take the rest by source coord.
      const rest: number[] = [];
      for (let i = 0; i < n; i++) if (!done[i]) rest.push(i);
      rest.sort(bySrc);
      for (const i of rest) {
        order.push(i);
        done[i] = true;
      }
      break;
    }
    ready.sort(bySrc);
    const pick = ready[0]!;
    order.push(pick);
    done[pick] = true;
    for (const s of succ[pick]!) indeg[s]!--;
  }

  const gap = Math.abs(gapTo - gapFrom);
  const clear = jogClearance(gap, step);
  const usable = lanes.filter((l) => !opts.used?.has(l));
  if (!usable.length) return out;
  // Lanes inside the source clearance would be the "stair after the pin".
  const safe = usable.filter((l) => Math.abs(l - gapFrom) > clear + 0.5);
  const pool = safe.length ? safe : usable;
  const k = pool.length;
  const maxShift = Math.max(...wires.map((w) => Math.abs(w.dst - w.src)));
  void maxShift;

  if (n <= k) {
    // Contiguous block at the destination approach — buses should jog near
    // the far pin stack (KiCad look), not in the middle of a wide gap.
    const start = k - n;
    order.forEach((wi, i) => out.set(wires[wi]!.id, pool[start + i]!));
    return out;
  }

  // Tight gap: walk lanes in order, sharing one with an earlier wire whose
  // span stays at least half a grid away; only fall back to a lane the
  // scorer will flag as overlap when nothing else is free.
  const spansOnLane: [number, number][][] = Array.from({ length: k }, () => []);
  const fits = (lane: number, s: [number, number]): boolean =>
    spansOnLane[lane]!.every(([lo, hi]) => s[0] >= hi + step * 0.5 || s[1] <= lo - step * 0.5);
  let cursor = 0;
  order.forEach((wi, i) => {
    const w = wires[wi]!;
    const s = span(w);
    const target = Math.min(k - 1, Math.max(cursor, Math.floor((i * k) / n)));
    const tries: number[] = [];
    for (let l = target; l < k; l++) tries.push(l);
    for (let l = target - 1; l >= 0; l--) tries.push(l);
    const lane = tries.find((l) => fits(l, s)) ?? target;
    spansOnLane[lane]!.push(s);
    cursor = Math.max(cursor, lane);
    out.set(w.id, pool[lane]!);
  });
  return out;
}
