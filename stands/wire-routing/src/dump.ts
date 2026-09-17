/**
 * Dump a fixture as SVG to stdout (or --out path).
 * Usage: npx vite-node stands/wire-routing/src/dump.ts face-to-face
 */
import { writeFileSync } from 'node:fs';
import { listFixtures, loadFixture, runFixture } from './harness.js';

const name = process.argv[2];
if (!name) {
  console.error('Usage: dump.ts <fixture-name>');
  console.error('Fixtures:', listFixtures().join(', '));
  process.exit(1);
}

const fixture = loadFixture(name);
const results = runFixture(fixture);

let minX = Infinity;
let minY = Infinity;
let maxX = -Infinity;
let maxY = -Infinity;
for (const box of fixture.obstacles) {
  minX = Math.min(minX, box.minX);
  minY = Math.min(minY, box.minY);
  maxX = Math.max(maxX, box.maxX);
  maxY = Math.max(maxY, box.maxY);
}
for (const r of results) {
  for (const p of r.path) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
}
const pad = 40;
minX -= pad;
minY -= pad;
maxX += pad;
maxY += pad;
const w = maxX - minX;
const h = maxY - minY;

const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c'];

const bodyRects = fixture.obstacles
  .map(
    (b) =>
      `<rect x="${b.minX}" y="${b.minY}" width="${b.maxX - b.minX}" height="${b.maxY - b.minY}" fill="#2c3e50" opacity="0.85"/>`,
  )
  .join('\n');

const wires = results
  .map((r, i) => {
    const d = r.path.map((p, j) => `${j === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
    const c = colors[i % colors.length]!;
    return `<path d="${d}" fill="none" stroke="${c}" stroke-width="3" stroke-linejoin="round"/>
  <text x="${r.path[0]!.x}" y="${r.path[0]!.y - 6}" fill="${c}" font-size="11" font-family="monospace">${r.id} b=${r.bends} L=${r.length}${r.hits ? ' HIT' : ''}</text>`;
  })
  .join('\n');

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${w} ${h}" width="${w}" height="${h}">
  <rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="#12141a"/>
  ${bodyRects}
  ${wires}
  <text x="${minX + 8}" y="${minY + 18}" fill="#aaa" font-size="13" font-family="sans-serif">${fixture.name}</text>
</svg>
`;

const outIdx = process.argv.indexOf('--out');
if (outIdx >= 0 && process.argv[outIdx + 1]) {
  writeFileSync(process.argv[outIdx + 1]!, svg);
  console.error('Wrote', process.argv[outIdx + 1]);
} else {
  process.stdout.write(svg);
}
