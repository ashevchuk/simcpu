import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathHitsObstacles, pathLength, pathOverlapLength, bendCount } from './score.js';
import { routeEscapeChannel } from './route.js';
import type { Fixture, Point } from './types.js';

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

export function runFixture(fixture: Fixture): NetResult[] {
  const grid = fixture.grid ?? 10;
  const drawn: Point[][] = [];
  const results: NetResult[] = [];
  for (const net of fixture.nets) {
    const avoidOverlap = drawn.filter((p) => !sharesEndpoint(p, net.from, net.to));
    const obstacles = net.obstacles ?? fixture.obstacles;
    const path = routeEscapeChannel({
      from: net.from,
      to: net.to,
      startDir: net.startDir,
      endDir: net.endDir,
      obstacles,
      avoidOverlap,
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
    drawn.push(path);
  }
  return results;
}
