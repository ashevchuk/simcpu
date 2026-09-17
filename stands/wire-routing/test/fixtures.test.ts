import { describe, expect, it } from 'vitest';
import { listFixtures, loadFixture, runFixture } from '../src/harness.js';
import { escapePoint, routeEscapeChannel, simplifyOrthoPath } from '../src/route.js';
import { pathHitsObstacles, pathOverlapLength } from '../src/score.js';

describe('escape-channel stand', () => {
  it('escapePoint walks clear of a body along exit dir', () => {
    const box = { minX: 0, minY: 0, maxX: 80, maxY: 100 };
    const esc = escapePoint({ x: 80, y: 50 }, 'E', [box], 10, 2);
    expect(esc.x).toBeGreaterThanOrEqual(100);
    expect(esc.y).toBe(50);
  });

  it('simplifyOrthoPath drops colinear mids', () => {
    expect(
      simplifyOrthoPath([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
    ]);
  });

  for (const name of listFixtures()) {
    it(`fixture ${name}: no body hits + ceilings`, () => {
      const fixture = loadFixture(name);
      const results = runFixture(fixture);
      expect(results.length).toBe(fixture.nets.length);

      for (let i = 0; i < results.length; i++) {
        const net = fixture.nets[i]!;
        const r = results[i]!;
        expect(r.hits, `${net.id} hits body`).toBe(false);
        expect(pathHitsObstacles(r.path, net.obstacles ?? fixture.obstacles)).toBe(false);
        if (net.maxBends != null) {
          expect(r.bends, `${net.id} bends`).toBeLessThanOrEqual(net.maxBends);
        }
        if (net.maxLength != null) {
          expect(r.length, `${net.id} length`).toBeLessThanOrEqual(net.maxLength);
        }
      }
    });
  }

  it('ribbon-4 trunks do not stack on the same Y', () => {
    const fixture = loadFixture('ribbon-4');
    const results = runFixture(fixture);
    const horizYs = new Set<number>();
    for (const r of results) {
      // Main span Y: longest horizontal segment.
      let bestY = r.path[0]!.y;
      let bestLen = 0;
      for (let i = 0; i < r.path.length - 1; i++) {
        const a = r.path[i]!;
        const b = r.path[i + 1]!;
        if (Math.abs(a.y - b.y) < 0.5) {
          const len = Math.abs(a.x - b.x);
          if (len > bestLen) {
            bestLen = len;
            bestY = a.y;
          }
        }
      }
      expect(horizYs.has(bestY), `stacked trunk at y=${bestY}`).toBe(false);
      horizYs.add(bestY);
    }
    // Also: pairwise overlap of full paths should be ~0.
    for (let i = 1; i < results.length; i++) {
      const prior = results.slice(0, i).map((r) => r.path);
      expect(pathOverlapLength(results[i]!.path, prior)).toBe(0);
    }
  });

  it('around-body skirts the package (not a through-L)', () => {
    const fixture = loadFixture('around-body');
    const [r] = runFixture(fixture);
    expect(r!.hits).toBe(false);
    expect(r!.bends).toBeGreaterThanOrEqual(2);
    // Must leave the blocked mid-band at y=100 for some vertical run.
    const ys = new Set(r!.path.map((p) => p.y));
    expect([...ys].some((y) => y !== 100)).toBe(true);
  });

  it('perf: 50 random clear pairs under 2ms average', () => {
    const obstacles = [
      { minX: 100, minY: 100, maxX: 200, maxY: 200 },
      { minX: 300, minY: 150, maxX: 400, maxY: 280 },
    ];
    const t0 = performance.now();
    const n = 50;
    for (let i = 0; i < n; i++) {
      const y = 40 + (i % 10) * 10;
      routeEscapeChannel({
        from: { x: 40, y },
        to: { x: 460, y: y + ((i % 3) - 1) * 20 },
        startDir: 'E',
        endDir: 'W',
        obstacles,
      });
    }
    const avg = (performance.now() - t0) / n;
    expect(avg).toBeLessThan(2);
  });
});
