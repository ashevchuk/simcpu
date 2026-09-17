/**
 * Embed freeware Spectrum TAP/SNA fixtures as base64 for file:// + tests.
 * Run: npx vite-node scripts/gen-spectrum-games.ts
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gamesDir = join(root, 'third_party/spectrum/games');
const outPath = join(root, 'src/machine/spectrum/gamesData.ts');

type Meta = { id: string; title: string; kind: 'sna' | 'tap'; note: string; model?: '48' | '128' };

const META: Record<string, Meta> = {
  'ay-beep128.sna': {
    id: 'ay-beep',
    title: 'AY beep demo (128K SNA)',
    kind: 'sna',
    note: 'Project smoke — AY tone + border',
    model: '128',
  },
  'rainbow-demo.sna': {
    id: 'rainbow',
    title: 'Rainbow demo (SNA)',
    kind: 'sna',
    note: 'Project smoke snapshot — colour attrs',
    model: '48',
  },
  'glazx48.tap': {
    id: 'glazx',
    title: 'GLAZX',
    kind: 'tap',
    note: 'MIT — LOAD ""',
  },
  'Homebrew.tap': {
    id: 'homebrew',
    title: 'Homebrew',
    kind: 'tap',
    note: 'Cauldwell freeware — LOAD ""',
  },
  'Egghead.tap': {
    id: 'egghead',
    title: 'Egghead',
    kind: 'tap',
    note: 'Cauldwell freeware — LOAD ""',
  },
  'EggheadInSpace.tap': {
    id: 'egghead-space',
    title: 'Egghead in Space',
    kind: 'tap',
    note: 'Cauldwell freeware — LOAD ""',
  },
  'pZXl.tap': {
    id: 'pzxl',
    title: 'ParaZXland',
    kind: 'tap',
    note: 'Keep pZXl.txt — LOAD ""',
  },
};

function b64(buf: Buffer): string {
  return buf.toString('base64');
}

const entries: string[] = [];
for (const file of readdirSync(gamesDir).sort()) {
  const meta = META[file];
  if (!meta) continue;
  const data = readFileSync(join(gamesDir, file));
  entries.push(`  {
    id: ${JSON.stringify(meta.id)},
    title: ${JSON.stringify(meta.title)},
    kind: ${JSON.stringify(meta.kind)},
    file: ${JSON.stringify(file)},
    note: ${JSON.stringify(meta.note)},
    b64: ${JSON.stringify(b64(data))},${meta.model ? `\n    model: '${meta.model}',` : ''}
  }`);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  `/**
 * Embedded Spectrum game fixtures (generated — do not edit).
 * Source: third_party/spectrum/games/ — see README there for licenses.
 * Regenerate: npx vite-node scripts/gen-spectrum-games.ts
 */

export type SpectrumGameKind = 'sna' | 'tap';

export type SpectrumGameEntry = {
  id: string;
  title: string;
  kind: SpectrumGameKind;
  file: string;
  note: string;
  b64: string;
  /** Preferred soft model when booting via \`#demo=\` (default 48). */
  model?: '48' | '128';
};

export const SPECTRUM_GAMES: readonly SpectrumGameEntry[] = [
${entries.join(',\n')}
];

export function decodeSpectrumGame(entry: SpectrumGameEntry): Uint8Array {
  const bin = atob(entry.b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function findSpectrumGame(id: string): SpectrumGameEntry | undefined {
  return SPECTRUM_GAMES.find((g) => g.id === id);
}
`,
  'utf8',
);

console.log(`Wrote ${outPath} (${entries.length} games)`);
