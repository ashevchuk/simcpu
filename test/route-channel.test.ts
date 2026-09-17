import { describe, expect, it } from 'vitest';
import counterLab from '../examples/lab-counter-7seg.json';
import type { Point } from '../src/sim/types.js';
import { deserializeProject } from '../src/sim/serialize.js';
import { Editor } from '../src/ui/Editor.js';
import { routeEscapeChannel } from '../src/ui/routeChannel.js';
import {
  routeWirePoints,
  pinExitDir,
  wireApproachLanes,
  wirePolyline,
  type Aabb,
} from '../src/ui/geometry.js';

const GRID = 10;

function verticalRuns(path: Point[]): { x: number; y0: number; y1: number }[] {
  const out: { x: number; y0: number; y1: number }[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) > 0.5) out.push({ x: a.x, y0: a.y, y1: b.y });
  }
  return out;
}

/** Same rule the router uses: jog clearance from a pin, capped at half the gap. */
function clearance(gap: number): number {
  return Math.min(GRID * 2.5, Math.max(0, gap / 2 - GRID * 0.5));
}

describe('channel router (tidy path)', () => {
  const left: Aabb = { minX: 0, minY: 20, maxX: 80, maxY: 140 };
  const right: Aabb = { minX: 220, minY: 20, maxX: 300, maxY: 140 };

  it('routes face-to-face clear of bodies with router:channel', () => {
    const path = routeWirePoints(
      [
        { x: 80, y: 60 },
        { x: 220, y: 60 },
      ],
      {
        obstacles: [left, right],
        startDir: 'E',
        endDir: 'W',
        router: 'channel',
      },
    );
    expect(path.length).toBe(2);
    expect(path[0]).toEqual({ x: 80, y: 60 });
    expect(path[path.length - 1]).toEqual({ x: 220, y: 60 });
  });

  it('skirts a blocking body instead of cutting through', () => {
    const wall: Aabb = { minX: 80, minY: 40, maxX: 200, maxY: 160 };
    const path = routeWirePoints(
      [
        { x: 40, y: 100 },
        { x: 240, y: 100 },
      ],
      {
        obstacles: [wall],
        startDir: 'E',
        endDir: 'W',
        router: 'channel',
      },
    );
    expect(path.length).toBeGreaterThan(2);
    const ys = new Set(path.map((p) => p.y));
    expect([...ys].some((y) => y !== 100)).toBe(true);
  });

  it('spreads fan-in verticals across distinct mid-X channels', () => {
    const chip: Aabb = { minX: 200, minY: 40, maxX: 280, maxY: 200 };
    const drawn: { x: number; y: number }[][] = [];
    const verticalXs = new Set<number>();
    // Long vertical runs (button column far below → chip) must take distinct channels.
    for (let i = 0; i < 6; i++) {
      const path = routeWirePoints(
        [
          { x: 20, y: 320 + i * 30 },
          { x: 200, y: 70 + i * 20 },
        ],
        {
          obstacles: [chip],
          startDir: 'E',
          endDir: 'W',
          avoidOverlap: drawn,
          router: 'channel',
        },
      );
      drawn.push(path);
      for (let j = 0; j < path.length - 1; j++) {
        const a = path[j]!;
        const b = path[j + 1]!;
        if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) >= 80) {
          verticalXs.add(a.x);
        }
      }
    }
    expect(verticalXs.size).toBeGreaterThanOrEqual(4);
  });

  it('near-aligned ribbon shares approach column without leftward loops', () => {
    const left: Aabb = { minX: 0, minY: 100, maxX: 80, maxY: 220 };
    const right: Aabb = { minX: 220, minY: 100, maxX: 300, maxY: 220 };
    const drawn: { x: number; y: number }[][] = [];
    for (let i = 0; i < 4; i++) {
      const y = 120 + i * 20;
      const path = routeWirePoints(
        [
          { x: 80, y },
          { x: 220, y: y + 10 },
        ],
        {
          obstacles: [left, right],
          startDir: 'E',
          endDir: 'W',
          avoidOverlap: drawn,
          router: 'channel',
        },
      );
      drawn.push(path);
      for (let j = 0; j < path.length - 1; j++) {
        const a = path[j]!;
        const b = path[j + 1]!;
        // No segment goes back toward the source along X.
        if (Math.abs(a.y - b.y) < 0.5) {
          expect(b.x).toBeGreaterThanOrEqual(a.x - 0.5);
        }
      }
      expect(path.length).toBeLessThanOrEqual(4);
    }
  });

  it('keeps the first vertical clear of the source pin even when the near-destination lanes are taken', () => {
    // E→W pair 7 grid apart, dy = 1 grid. A neighbour already occupies the
    // lane next to the destination, so the router must either share it or
    // pick another lane ≥ 3 grid from the source — never a stair at +1/+2 grid.
    const from = { x: 200, y: 100 };
    const to = { x: 270, y: 110 };
    const neighbour: Point[] = [
      { x: 200, y: 80 },
      { x: 260, y: 80 },
      { x: 260, y: 120 },
      { x: 270, y: 120 },
    ];
    const path = routeEscapeChannel({
      from,
      to,
      obstacles: [],
      startDir: 'E',
      endDir: 'W',
      avoidOverlap: [neighbour],
    });
    expect(path.length).toBeLessThanOrEqual(4);
    for (const v of verticalRuns(path)) {
      expect(v.x - from.x, `vertical at x=${v.x} is a stair next to the pin`).toBeGreaterThanOrEqual(
        3 * GRID,
      );
    }
    for (let i = 0; i < path.length - 1; i++) {
      expect(path[i + 1]!.x).toBeGreaterThanOrEqual(path[i]!.x - 0.5);
    }
  });

  it('shares a lane instead of looping behind the source when the gap is congested', () => {
    // Packages ~3 grid apart with both free lanes already used over the full
    // span: the only alternatives are sharing a lane or a U-turn around the
    // source body. The U-turn must lose.
    const from = { x: 116, y: 420 };
    const to = { x: 150, y: 230 };
    const spine = (x: number): Point[] => [
      { x: 116, y: 100 },
      { x, y: 100 },
      { x, y: 460 },
      { x: 150, y: 460 },
    ];
    const path = routeEscapeChannel({
      from,
      to,
      obstacles: [],
      hostObstacles: [
        { minX: 60, minY: 60, maxX: 116, maxY: 480 },
        { minX: 150, minY: 60, maxX: 250, maxY: 300 },
      ],
      startDir: 'E',
      endDir: 'W',
      avoidOverlap: [spine(130), spine(140)],
    });
    expect(path.length).toBeLessThanOrEqual(4);
    for (const p of path) {
      expect(p.x, 'route loops behind the source pin').toBeGreaterThanOrEqual(from.x - 0.5);
      expect(p.x, 'route runs past the destination pin').toBeLessThanOrEqual(to.x + 0.5);
    }
  });

  it('jogs before a later wire\'s reserved approach row instead of stealing it', () => {
    // CE-style wire leaving y=140 toward a pin at y=100; a later wire needs
    // y=140 to enter its own pin at (330,140). Without the reservation the
    // jog sits next to the destination and blocks that approach.
    const from = { x: 116, y: 140 };
    const to = { x: 330, y: 100 };
    const reservedLanes = wireApproachLanes({ x: 116, y: 340 }, 'E', { x: 330, y: 140 }, 'W');
    expect(reservedLanes).toEqual([
      { axis: 'h', coord: 340, lo: 116, hi: 223 },
      { axis: 'h', coord: 140, lo: 223, hi: 330 },
    ]);
    const free = routeEscapeChannel({ from, to, obstacles: [], startDir: 'E', endDir: 'W' });
    const reserved = routeEscapeChannel({
      from,
      to,
      obstacles: [],
      startDir: 'E',
      endDir: 'W',
      reservedLanes,
    });
    expect(verticalRuns(free)[0]!.x).toBeGreaterThan(223);
    const jog = verticalRuns(reserved)[0]!;
    expect(jog.x).toBeLessThanOrEqual(223);
    expect(jog.x - from.x).toBeGreaterThanOrEqual(3 * GRID);
  });

  it('default pattern router still works without router flag', () => {
    const path = routeWirePoints(
      [
        { x: 0, y: 0 },
        { x: 40, y: 30 },
      ],
      { startDir: pinExitDir({ x: 0, y: 0 }, { x: -20, y: 0 }) },
    );
    expect(path.length).toBeGreaterThanOrEqual(2);
  });
});

describe('drag a chip, then tidy (lab-counter-7seg)', () => {
  /** tidyAllWires → move COUNTER4 like a drag → pushWiresWithDrag → tidy selection. */
  function dragAndTidy(dx: number, dy: number): { id: string; path: Point[] }[] {
    const { topCircuit, library } = deserializeProject(
      structuredClone(counterLab) as Parameters<typeof deserializeProject>[0],
    );
    const editor = new Editor(topCircuit, library);
    editor.tidyAllWires(false);
    const counter = [...topCircuit.components.values()].find(
      (c) => (c as { defName?: string }).defName === 'COUNTER4',
    )!;
    topCircuit.moveComponent(counter.id, dx, dy);
    editor.pushWiresWithDrag([counter.id], dx, dy);
    editor.selectedIds = new Set([counter.id]);
    editor.selectedWireIds = new Set();
    editor.tidySelectedWires(false, { preserveManual: false });

    const pinById = new Map(topCircuit.allPins().map((p) => [p.id, p]));
    return [...topCircuit.wires.values()].flatMap((w) => {
      const a = pinById.get(w.a);
      const b = pinById.get(w.b);
      const path = wirePolyline(topCircuit, w);
      if (!a || !b || !path || path.length < 2) return [];
      return [{ id: `${a.name}->${b.componentId}:${b.name}`, path }];
    });
  }

  function colinearOverlap(p: Point[], q: Point[]): number {
    let total = 0;
    for (let i = 0; i < p.length - 1; i++) {
      for (let j = 0; j < q.length - 1; j++) {
        const [a0, a1, b0, b1] = [p[i]!, p[i + 1]!, q[j]!, q[j + 1]!];
        const aV = Math.abs(a0.x - a1.x) < 0.5;
        if (aV !== Math.abs(b0.x - b1.x) < 0.5) continue;
        const [k, m] = aV ? (['x', 'y'] as const) : (['y', 'x'] as const);
        if (Math.abs(a0[k] - b0[k]) > 0.5) continue;
        const lo = Math.max(Math.min(a0[m], a1[m]), Math.min(b0[m], b1[m]));
        const hi = Math.min(Math.max(a0[m], a1[m]), Math.max(b0[m], b1[m]));
        if (hi > lo) total += hi - lo;
      }
    }
    return total;
  }

  // Moderate moves: the gap between buttons and chip (and chip → decoder)
  // stays wide enough that a clean route exists for every wire.
  for (const [dx, dy] of [
    [90, 0],
    [-30, -30],
    [0, -30],
    [30, 50],
    [60, -50],
    [90, -50],
  ] as const) {
    it(`no source stair, U-turn or spur after moving by ${dx},${dy}`, () => {
      const wires = dragAndTidy(dx, dy);
      for (const { id, path } of wires) {
        const from = path[0]!;
        const to = path[path.length - 1]!;
        expect(path.length, `${id} has too many bends`).toBeLessThanOrEqual(5);
        // Every wire here leaves an E-facing pin: the first vertical must sit
        // outside the source clearance (2.5 grid, capped at half the gap).
        const clear = clearance(Math.abs(to.x - from.x));
        for (const v of verticalRuns(path)) {
          expect(Math.abs(v.x - from.x), `${id} stairs at x=${v.x} next to its pin`).toBeGreaterThan(
            clear + 0.5,
          );
        }
        const dirX = Math.sign(to.x - from.x);
        for (let i = 0; i < path.length - 1; i++) {
          const a = path[i]!;
          const b = path[i + 1]!;
          if (Math.abs(a.y - b.y) > 0.5) continue;
          expect(Math.sign(b.x - a.x) * dirX, `${id} backtracks on X`).toBeGreaterThanOrEqual(0);
        }
        for (let i = 0; i + 2 < path.length; i++) {
          const a = path[i]!;
          const c = path[i + 2]!;
          expect(
            Math.abs(a.x - c.x) > 0.5 || Math.abs(a.y - c.y) > 0.5,
            `${id} has a reverse spur`,
          ).toBe(true);
        }
      }
    });
  }

  it('after +90 the Q outputs take one jog near the decoder and the fan-in keeps distinct lanes', () => {
    const wires = dragAndTidy(90, 0);
    const q = wires.filter((w) => /^q\d->/.test(w.id));
    expect(q.length).toBe(4);
    for (const { id, path } of q) {
      const from = path[0]!;
      const to = path[path.length - 1]!;
      const vs = verticalRuns(path);
      expect(vs.length, `${id} shape`).toBe(1);
      expect(vs[0]!.x - from.x).toBeGreaterThanOrEqual(3 * GRID);
      expect(to.x - vs[0]!.x).toBeLessThanOrEqual((to.x - from.x) / 2);
    }
    // Button → chip fan-in: long verticals never merge into one trunk.
    const fanIn = wires.filter((w) => w.id.startsWith('out->'));
    expect(fanIn.length).toBe(8);
    for (let i = 0; i < fanIn.length; i++) {
      for (let j = i + 1; j < fanIn.length; j++) {
        expect(
          colinearOverlap(fanIn[i]!.path, fanIn[j]!.path),
          `${fanIn[i]!.id} overlaps ${fanIn[j]!.id}`,
        ).toBeLessThanOrEqual(GRID);
      }
    }
  });
});
