import { buildZ80Cpu } from '../src/sim/blocks.js';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { seedStandardCells } from '../src/sim/stdcells.js';

/**
 * Place-only timing for buildZ80Cpu (addrBits=12) — no fold/flatten.
 * Run: npx tsx scripts/bench-build.mts
 */
const ADDR_BITS = 12;
const RUNS = 3;

function once(seed: boolean): number {
  const library = new ChipLibrary();
  if (seed) seedStandardCells(library);
  const parent = new Circuit();
  const t0 = performance.now();
  buildZ80Cpu(parent, library, ADDR_BITS, new Uint8Array([0x00]), { x: 0, y: 0 });
  const ms = performance.now() - t0;
  console.log(
    seed ? 'seeded' : 'bare  ',
    'buildZ80Cpu ms',
    ms.toFixed(0),
    'components',
    parent.components.size,
    'wires',
    parent.wires.size,
    'defs',
    library.list().length,
  );
  return ms;
}

console.time('warm');
once(false);
console.timeEnd('warm');

const samples: number[] = [];
for (let i = 0; i < RUNS; i++) samples.push(once(false));
const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
console.log('avg bare ms', avg.toFixed(0), 'samples', samples.map((m) => m.toFixed(0)).join(','));

once(true);
