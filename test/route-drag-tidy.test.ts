import { describe, expect, it } from 'vitest';
import counterLab from '../examples/lab-counter-7seg.json';
import type { Point } from '../src/sim/types.js';
import { deserializeProject } from '../src/sim/serialize.js';
import { Editor } from '../src/ui/Editor.js';
import { routeEscapeChannel } from '../src/ui/routeChannel.js';
import { wirePolyline, type Aabb } from '../src/ui/geometry.js';

const GRID = 10;

function verticals(path: Point[]): { x: number; len: number }[] {
  const out: { x: number; len: number }[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) > 0.5) {
      out.push({ x: a.x, len: Math.abs(a.y - b.y) });
    }
  }
  return out;
}

describe('channel router: pin escape lanes', () => {
  const src: Aabb = { minX: 100, minY: 20, maxX: 200, maxY: 220 };
  const dst: Aabb = { minX: 320, minY: 20, maxX: 420, maxY: 220 };

  it('keeps the jog clear of the source pin column (E→W, small dy)', () => {
    const path = routeEscapeChannel({
      from: { x: 200, y: 100 },
      to: { x: 320, y: 130 },
      obstacles: [],
      hostObstacles: [src, dst],
      startDir: 'E',
      endDir: 'W',
    });
    expect(path[0]).toEqual({ x: 200, y: 100 });
    expect(path[path.length - 1]).toEqual({ x: 320, y: 130 });
    expect(path.length).toBeLessThanOrEqual(4);
    for (const v of verticals(path)) {
      expect(Math.abs(v.x - 200), `vertical at x=${v.x} hugs the source pin`).toBeGreaterThanOrEqual(
        3 * GRID,
      );
    }
  });

  it('never turns on the pin column when the pins are perpendicular', () => {
    // Source fires E, destination pin faces N: expect H then V, no stub jog.
    const path = routeEscapeChannel({
      from: { x: 200, y: 100 },
      to: { x: 300, y: 260 },
      obstacles: [],
      hostObstacles: [src],
      startDir: 'E',
      endDir: 'N',
    });
    expect(path).toEqual([
      { x: 200, y: 100 },
      { x: 300, y: 100 },
      { x: 300, y: 260 },
    ]);
  });

  it('jogs mid-gap when packages nearly touch instead of looping behind a pin', () => {
    // COUNTER4 dragged until its Q column sits one grid from the decoder D
    // column; the package boxes (pin inset) already overlap.
    const counter: Aabb = { minX: 384, minY: 97, maxX: 476, maxY: 263 };
    const decoder: Aabb = { minX: 474, minY: 107, maxX: 566, maxY: 253 };
    const path = routeEscapeChannel({
      from: { x: 470, y: 140 },
      to: { x: 480, y: 150 },
      obstacles: [],
      hostObstacles: [counter, decoder],
      startDir: 'E',
      endDir: 'W',
    });
    expect(path.length).toBe(4);
    for (const p of path) {
      expect(p.x).toBeGreaterThanOrEqual(470);
      expect(p.x).toBeLessThanOrEqual(480);
    }
  });

  it('never runs straight through its own packages when pins face away', () => {
    const left: Aabb = { minX: 100, minY: 100, maxX: 192, maxY: 200 };
    const right: Aabb = { minX: 300, minY: 100, maxX: 392, maxY: 200 };
    // E pin on the right chip → W pin on the left chip, same row.
    const path = routeEscapeChannel({
      from: { x: 386, y: 150 },
      to: { x: 106, y: 150 },
      obstacles: [],
      hostObstacles: [left, right],
      startDir: 'E',
      endDir: 'W',
    });
    expect(path.length).toBeGreaterThanOrEqual(4);
    // Leaves eastward, enters from the west, wraps around outside the bodies.
    expect(path[1]!.x).toBeGreaterThan(386);
    expect(path[path.length - 2]!.x).toBeLessThan(106);
    for (let i = 1; i < path.length - 2; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      if (Math.abs(a.y - b.y) < 0.5) {
        expect(a.y < 100 || a.y > 200, `segment ${i} crosses a package at y=${a.y}`).toBe(true);
      }
    }
  });

  it('does not cross its own package to reach a pin', () => {
    // Destination pin on the left edge of dst: approach must stay left of it.
    const path = routeEscapeChannel({
      from: { x: 200, y: 200 },
      to: { x: 320, y: 60 },
      obstacles: [],
      hostObstacles: [src, dst],
      startDir: 'E',
      endDir: 'W',
    });
    for (const p of path) expect(p.x).toBeLessThanOrEqual(320.5);
  });
});

describe('drag a chip, then tidy', () => {
  /** Move the 4-bit counter, push wires like a drag does, then re-tidy. */
  function dragAndTidy(dx: number, dy: number) {
    const { topCircuit, library } = deserializeProject(
      structuredClone(counterLab) as Parameters<typeof deserializeProject>[0],
    );
    const editor = new Editor(topCircuit, library);
    editor.tidyAllWires(false);
    const counter = [...topCircuit.components.values()].find(
      (c) => (c as { defName?: string }).defName === 'COUNTER4',
    );
    expect(counter).toBeDefined();
    topCircuit.moveComponent(counter!.id, dx, dy);
    editor.pushWiresWithDrag([counter!.id], dx, dy);
    editor.selectedIds = new Set([counter!.id]);
    editor.selectedWireIds = new Set();
    editor.tidySelectedWires(false, { preserveManual: false });

    const pinById = new Map(topCircuit.allPins().map((p) => [p.id, p]));
    return [...topCircuit.wires.values()].flatMap((w) => {
      const a = pinById.get(w.a);
      const b = pinById.get(w.b);
      const path = wirePolyline(topCircuit, w);
      if (!a || !b || !path || path.length < 2) return [];
      return [{ id: `${a.id}->${b.id}`, path }];
    });
  }

  /** Same rule as the router: a jog must clear the pin by up to 2.5 grid. */
  function jogClearance(gap: number): number {
    return Math.min(GRID * 2.5, Math.max(0, gap / 2 - GRID * 0.5));
  }

  for (const [dx, dy] of [
    [90, 0],
    [0, 60],
    [60, 40],
    [30, 90],
    [150, 0],
  ] as const) {
    it(`leaves no spurs or pin-column jogs after moving by ${dx},${dy}`, () => {
      for (const { id, path } of dragAndTidy(dx, dy)) {
        const from = path[0]!;
        const to = path[path.length - 1]!;
        expect(path.length, `${id} bends`).toBeLessThanOrEqual(5);
        // Every wire in this lab leaves an E/W pin: no vertical dogleg may sit
        // on or right next to the source pin column (the "stair after the pin").
        const clear = jogClearance(Math.abs(to.x - from.x));
        for (const v of verticals(path)) {
          expect(Math.abs(v.x - from.x), `${id} stairs next to its source pin`).toBeGreaterThan(clear);
          expect(Math.abs(v.x - to.x), `${id} turns on its destination column`).toBeGreaterThan(0.5);
        }
        // No reverse spur: a → b → a collapses to nothing visible but a stub.
        for (let i = 0; i + 2 < path.length; i++) {
          const a = path[i]!;
          const c = path[i + 2]!;
          expect(
            Math.abs(a.x - c.x) > 0.5 || Math.abs(a.y - c.y) > 0.5,
            `${id} has a reverse spur at ${i + 1}`,
          ).toBe(true);
        }
        // Monotone along X: no U-turns back toward the source.
        const dirX = Math.sign(to.x - from.x);
        if (dirX !== 0) {
          for (let i = 0; i < path.length - 1; i++) {
            const a = path[i]!;
            const b = path[i + 1]!;
            if (Math.abs(a.y - b.y) > 0.5) continue;
            expect(
              Math.sign(b.x - a.x) === 0 || Math.sign(b.x - a.x) === dirX,
              `${id} backtracks on X`,
            ).toBe(true);
          }
        }
      }
    });
  }

  it('keeps the counter Q outputs on a single jog near the destination', () => {
    const wires = dragAndTidy(90, 0).filter((w) => /:q\d->/.test(w.id));
    expect(wires.length).toBe(4);
    for (const { id, path } of wires) {
      expect(path.length, `${id} shape`).toBeLessThanOrEqual(4);
      const from = path[0]!;
      const to = path[path.length - 1]!;
      const vs = verticals(path);
      expect(vs.length, `${id} vertical count`).toBe(1);
      // The jog belongs near the destination approach, not next to the pin.
      expect(Math.abs(vs[0]!.x - from.x)).toBeGreaterThanOrEqual(3 * GRID);
      expect(Math.abs(vs[0]!.x - to.x)).toBeLessThanOrEqual(Math.abs(to.x - from.x) / 2);
    }
  });
});
