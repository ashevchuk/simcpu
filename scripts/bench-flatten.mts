import { buildZ80Cpu } from '../src/sim/blocks.js';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit, currentStructureVersion } from '../src/sim/Circuit.js';
import { foldZ80CpuLeavingRam, newComponentIdSet } from '../src/sim/foldZ80.js';
import { flatten } from '../src/sim/hierarchy.js';

/**
 * Place/fold/flatten timings for a 12-bit Z80 (addrBits=12).
 *
 * Reports wall times for the Gates-path bottleneck trio:
 *   buildZ80Cpu → foldZ80CpuLeavingRam → flatten (cold + cache hit)
 */
const ADDR_BITS = 12;
const library = new ChipLibrary();
const parent = new Circuit();
const beforeIds = new Set(parent.components.keys());

const t0 = performance.now();
const cpu = buildZ80Cpu(parent, library, ADDR_BITS, new Uint8Array([0x00]), { x: 0, y: 0 });
const tBuild = performance.now();
const placed = newComponentIdSet(parent, beforeIds);
console.log(
  'buildZ80Cpu ms',
  (tBuild - t0).toFixed(0),
  'components',
  parent.components.size,
  'wires',
  parent.wires.size,
);

const t1 = performance.now();
foldZ80CpuLeavingRam(parent, library, placed, { x: 0, y: 0 });
const tFold = performance.now();
console.log('fold ms', (tFold - t1).toFixed(0), 'top components', parent.components.size);

let chipInst = null as ReturnType<typeof parent.components.get>;
for (const c of parent.components.values()) if (c.kind === 'chip') chipInst = c;
const def = library.get((chipInst as { defId: string }).defId);
let nestedChips = 0;
const defCounts = new Map<string, number>();
for (const c of def.circuit.components.values()) {
  if (c.kind === 'chip') {
    nestedChips++;
    defCounts.set(c.defId, (defCounts.get(c.defId) || 0) + 1);
  }
}
console.log(
  'folded def components',
  def.circuit.components.size,
  'nested chips',
  nestedChips,
  'unique nested defs',
  defCounts.size,
);

const t2 = performance.now();
const flat = flatten(parent, library);
const tFlat1 = performance.now();
console.log(
  'flatten1 ms',
  (tFlat1 - t2).toFixed(0),
  'flat components',
  flat.components.size,
  'wires',
  flat.wires.size,
);

const t3 = performance.now();
flatten(parent, library);
const tFlat2 = performance.now();
console.log(
  'flatten2 (cache hit) ms',
  (tFlat2 - t3).toFixed(1),
  'structureVersion',
  currentStructureVersion(),
);

console.log(
  'summary build/fold/flatten_ms',
  (tBuild - t0).toFixed(0),
  (tFold - t1).toFixed(0),
  (tFlat1 - t2).toFixed(0),
);
void cpu;
