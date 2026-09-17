/**
 * Drag-then-tidy repro: load a lab example, tidy everything, move a chip,
 * push wires, re-tidy the selection, then audit the resulting polylines for
 * the artifacts users report (source-adjacent doglegs, reverse spurs,
 * backtracking segments).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deserializeProject } from '../../../src/sim/serialize.js';
import { ChipLibrary } from '../../../src/sim/ChipLibrary.js';
import { Editor } from '../../../src/ui/Editor.js';
import { pinRouteDir, routingObstacles, wirePolyline } from '../../../src/ui/geometry.js';
import type { Point } from '../../../src/sim/types.js';

const file = process.argv[2] ?? 'examples/lab-counter-7seg.json';
const compMatch = (process.argv[3] ?? 'COUNTER4').toUpperCase();
const dx = Number(process.argv[4] ?? 90);
const dy = Number(process.argv[5] ?? 0);

const data = JSON.parse(readFileSync(file, 'utf8'));
const { topCircuit, library } = deserializeProject(data);
const editor = new Editor(topCircuit, library as ChipLibrary);

editor.tidyAllWires(false);

const nameOf = (c: { kind: string }): string => {
  const rec = c as { defName?: string; label?: string; kind: string };
  return (rec.defName ?? rec.label ?? rec.kind).toUpperCase();
};
const target = [...topCircuit.components.values()].find((c) => nameOf(c).includes(compMatch));
if (!target) {
  console.error('component not found:', compMatch);
  process.exit(1);
}
console.log(`moving ${target.id} (${nameOf(target)}) by ${dx},${dy}`);

topCircuit.moveComponent(target.id, dx, dy);
editor.pushWiresWithDrag([target.id], dx, dy);
editor.selectedIds = new Set([target.id]);
editor.selectedWireIds = new Set();
editor.tidySelectedWires(false);

const GRID = 10;
let problems = 0;

/** Same rule the router uses: clearance capped at half the gap. */
function clearance(gap: number): number {
  return Math.min(GRID * 2.5, Math.max(0, gap / 2 - GRID * 0.5));
}

function audit(
  name: string,
  pts: Point[],
  startAxis: 'h' | 'v' | null,
  endAxis: 'h' | 'v' | null,
): void {
  const from = pts[0]!;
  const to = pts[pts.length - 1]!;
  const issues: string[] = [];
  const rightward = to.x > from.x;
  const clearX = clearance(Math.abs(to.x - from.x));
  const clearY = clearance(Math.abs(to.y - from.y));
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const len = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    if (len < 0.5) continue;
    if (Math.abs(a.y - b.y) < 0.5) {
      if (rightward && b.x < a.x - 0.5) issues.push(`leftward seg ${i}`);
      if (!rightward && b.x > a.x + 0.5) issues.push(`rightward seg ${i}`);
      // Exit stair on a N/S pin's own row.
      if (startAxis === 'v' && Math.abs(a.y - from.y) <= Math.max(clearY, 0.5)) {
        issues.push(`source stair y=${a.y} len=${len} (pin y=${from.y})`);
      }
      if (
        len > GRID * 3 &&
        ((startAxis === 'v' && Math.abs(a.y - from.y) <= GRID * 1.5) ||
          (endAxis === 'v' && Math.abs(a.y - to.y) <= GRID * 1.5))
      ) {
        issues.push(`horizontal hugs pin row y=${a.y} len=${len}`);
      }
    } else if (Math.abs(a.x - b.x) < 0.5) {
      // Exit stair: any vertical hugging the column an E/W pin leaves from.
      if (startAxis === 'h' && Math.abs(a.x - from.x) <= Math.max(clearX, 0.5)) {
        issues.push(`source stair x=${a.x} len=${len} (pin x=${from.x})`);
      }
      // Long vertical sliding along an E/W pin's own column.
      if (
        len > GRID * 3 &&
        ((startAxis === 'h' && Math.abs(a.x - from.x) <= GRID * 1.5) ||
          (endAxis === 'h' && Math.abs(a.x - to.x) <= GRID * 1.5))
      ) {
        issues.push(`vertical hugs pin column x=${a.x} len=${len}`);
      }
    }
  }
  for (let i = 0; i + 2 < pts.length; i++) {
    const a = pts[i]!;
    const c = pts[i + 2]!;
    if (Math.abs(a.x - c.x) < 0.5 && Math.abs(a.y - c.y) < 0.5) issues.push(`spur at ${i + 1}`);
  }
  if (pts.length > 5) issues.push(`${pts.length - 2} bends`);
  const shape = pts.map((p) => `(${p.x},${p.y})`).join(' ');
  if (issues.length) {
    problems++;
    console.log(`BAD  ${name}: ${issues.join('; ')}\n     ${shape}`);
  } else {
    console.log(`ok   ${name}: ${shape}`);
  }
}

const pinById = new Map(topCircuit.allPins().map((p) => [p.id, p]));
const all: { id: string; a: string; b: string; path: Point[] }[] = [];
const axisOf = (d: string | null): 'h' | 'v' | null =>
  d === null ? null : d === 'E' || d === 'W' ? 'h' : 'v';
for (const w of topCircuit.wires.values()) {
  const a = pinById.get(w.a);
  const b = pinById.get(w.b);
  if (!a || !b) continue;
  const poly = wirePolyline(topCircuit, w);
  if (!poly || poly.length < 2) continue;
  all.push({ id: `${a.id}->${b.id}`, a: a.id, b: b.id, path: poly });
  if (a.componentId !== target.id && b.componentId !== target.id) continue;
  // Audit in the router's own orientation (pin `a` is `from`).
  const label = `${a.name}@${a.componentId === target.id ? 'moved' : 'fixed'} -> ${b.id}`;
  audit(
    label,
    poly,
    axisOf(pinRouteDir(a.pos, topCircuit.components.get(a.componentId))),
    axisOf(pinRouteDir(b.pos, topCircuit.components.get(b.componentId))),
  );
}

// Distinct wires on different nets must not run colinear on top of each other.
let overlaps = 0;
for (let i = 0; i < all.length; i++) {
  for (let j = i + 1; j < all.length; j++) {
    const u = all[i]!;
    const v = all[j]!;
    if (u.a === v.a || u.a === v.b || u.b === v.a || u.b === v.b) continue;
    const len = colinearOverlap(u.path, v.path);
    if (len > GRID) {
      overlaps++;
      console.log(`OVERLAP ${len}px between ${u.id} and ${v.id}`);
    }
  }
}

function colinearOverlap(p: Point[], q: Point[]): number {
  let total = 0;
  for (let i = 0; i < p.length - 1; i++) {
    for (let j = 0; j < q.length - 1; j++) {
      const a0 = p[i]!;
      const a1 = p[i + 1]!;
      const b0 = q[j]!;
      const b1 = q[j + 1]!;
      const aV = Math.abs(a0.x - a1.x) < 0.5;
      const bV = Math.abs(b0.x - b1.x) < 0.5;
      if (aV !== bV) continue;
      if (aV) {
        if (Math.abs(a0.x - b0.x) > 0.5) continue;
        const lo = Math.max(Math.min(a0.y, a1.y), Math.min(b0.y, b1.y));
        const hi = Math.min(Math.max(a0.y, a1.y), Math.max(b0.y, b1.y));
        if (hi > lo) total += hi - lo;
      } else {
        if (Math.abs(a0.y - b0.y) > 0.5) continue;
        const lo = Math.max(Math.min(a0.x, a1.x), Math.min(b0.x, b1.x));
        const hi = Math.min(Math.max(a0.x, a1.x), Math.max(b0.x, b1.x));
        if (hi > lo) total += hi - lo;
      }
    }
  }
  return total;
}

console.log(
  problems === 0 && overlaps === 0
    ? 'ALL CLEAN'
    : `${problems} problem wire(s), ${overlaps} overlap(s)`,
);

const outIdx = process.argv.indexOf('--svg');
const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : undefined;
if (outPath) {
  const boxes = routingObstacles(topCircuit);
  const xs = all.flatMap((w) => w.path.map((p) => p.x));
  const ys = all.flatMap((w) => w.path.map((p) => p.y));
  const pad = 30;
  const minX = Math.min(...xs, ...boxes.map((b) => b.minX)) - pad;
  const minY = Math.min(...ys, ...boxes.map((b) => b.minY)) - pad;
  const w = Math.max(...xs, ...boxes.map((b) => b.maxX)) + pad - minX;
  const h = Math.max(...ys, ...boxes.map((b) => b.maxY)) + pad - minY;
  const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22'];
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${w} ${h}" width="${w}" height="${h}">
  <rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="#12141a"/>
  ${boxes
    .map(
      (b) =>
        `<rect x="${b.minX}" y="${b.minY}" width="${b.maxX - b.minX}" height="${
          b.maxY - b.minY
        }" fill="#2c3e50"/>`,
    )
    .join('\n  ')}
  ${all
    .map((wire, i) => {
      const d = wire.path.map((p, j) => `${j === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
      return `<path d="${d}" fill="none" stroke="${
        colors[i % colors.length]
      }" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    })
    .join('\n  ')}
</svg>
`;
  writeFileSync(outPath, svg);
  console.log('wrote', outPath);
}
