import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathHitsObstacles, pathLength, pathOverlapLength, bendCount } from './score.js';
import { assignRibbonRails, routeEscapeChannel } from './route.js';
import type { Fixture, FixtureNet, Point } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(here, '..', 'fixtures');

export function loadFixture(name: string): Fixture {
  const raw = readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8');
  return JSON.parse(raw) as Fixture;
}

export function listFixtures(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

function near(a: Point, b: Point, eps = 0.5): boolean {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;
}

/** Paths that share an endpoint are junction splices — allow channel sharing. */
function sharesEndpoint(path: Point[], from: Point, to: Point): boolean {
  if (path.length < 1) return false;
  const a = path[0]!;
  const b = path[path.length - 1]!;
  return near(a, from) || near(a, to) || near(b, from) || near(b, to);
}

export interface NetResult {
  id: string;
  path: Point[];
  length: number;
  bends: number;
  hits: boolean;
  overlap: number;
}

/**
 * Ribbon rails for a fixture: nets are grouped like the editor groups wires
 * (facing E↔W or N↕S pairs between the same two pin rows/columns).
 */
export function fixtureRibbonRails(fixture: Fixture, grid: number): Map<string, number> {
  const groups = new Map<string, FixtureNet[]>();
  for (const net of fixture.nets) {
    const sd = net.startDir;
    const ed = net.endDir;
    if (!sd || !ed) continue;
    const h = (sd === 'E' && ed === 'W') || (sd === 'W' && ed === 'E');
    const v = (sd === 'N' && ed === 'S') || (sd === 'S' && ed === 'N');
    if (!h && !v) continue;
    const key = h ? `h|${net.from.x}|${net.to.x}` : `v|${net.from.y}|${net.to.y}`;
    const list = groups.get(key);
    if (list) list.push(net);
    else groups.set(key, [net]);
  }
  const rails = new Map<string, number>();
  for (const [key, nets] of groups) {
    if (nets.length < 2) continue;
    const h = key.startsWith('h');
    const first = nets[0]!;
    const assigned = assignRibbonRails(
      nets.map((n) => ({ id: n.id, src: h ? n.from.y : n.from.x, dst: h ? n.to.y : n.to.x })),
      h ? first.from.x : first.from.y,
      h ? first.to.x : first.to.y,
      { step: grid },
    );
    for (const [id, rail] of assigned) rails.set(id, rail);
  }
  return rails;
}

export function runFixture(fixture: Fixture): NetResult[] {
  const grid = fixture.grid ?? 10;
  const drawn: { path: Point[]; net?: string }[] = [];
  const results: NetResult[] = [];
  const rails = fixture.ribbonRails ? fixtureRibbonRails(fixture, grid) : new Map<string, number>();
  for (const net of fixture.nets) {
    const sameNet = net.net ? drawn.filter((d) => d.net === net.net).map((d) => d.path) : [];
    const avoidOverlap = drawn
      .filter((d) => !(net.net && d.net === net.net))
      .map((d) => d.path)
      .filter((p) => !sharesEndpoint(p, net.from, net.to));
    const obstacles = net.obstacles ?? fixture.obstacles;
    const path = routeEscapeChannel({
      from: net.from,
      to: net.to,
      startDir: net.startDir,
      endDir: net.endDir,
      obstacles,
      avoidOverlap,
      avoidCrossings: drawn.map((d) => d.path),
      preferAlong: sameNet,
      preferRail: rails.get(net.id),
      grid,
    });
    results.push({
      id: net.id,
      path,
      length: pathLength(path),
      bends: bendCount(path),
      hits: pathHitsObstacles(path, obstacles),
      overlap: pathOverlapLength(path, avoidOverlap),
    });
    drawn.push({ path, net: net.net });
  }
  return results;
}
