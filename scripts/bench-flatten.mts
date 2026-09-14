import { buildZ80Cpu } from '../src/sim/blocks.js';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit, currentStructureVersion } from '../src/sim/Circuit.js';
import { foldZ80CpuLeavingRam, newComponentIds } from '../src/sim/foldZ80.js';
import { flatten } from '../src/sim/hierarchy.js';

const library = new ChipLibrary();
const parent = new Circuit();
const before = new Set(parent.components.keys());
const t0 = performance.now();
const cpu = buildZ80Cpu(parent, library, 12, new Uint8Array([0x00]), { x: 0, y: 0 });
const tBuild = performance.now();
const placed = newComponentIds(parent, before);
console.log('buildZ80Cpu ms', (tBuild - t0).toFixed(0), 'components', parent.components.size);

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
const top = [...defCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log(
  'top nested defs',
  top.map(([id, n]) => id.slice(0, 40) + ':' + n).join(', '),
);
for (const [id, n] of top) {
  const d = library.get(id);
  let nested = 0;
  let transistors = 0;
  let other = 0;
  for (const c of d.circuit.components.values()) {
    if (c.kind === 'chip') nested++;
    else if (c.kind === 'transistor') transistors++;
    else other++;
  }
  console.log(
    '  def',
    id,
    'x' + n,
    'comps',
    d.circuit.components.size,
    'tx',
    transistors,
    'nestedChips',
    nested,
    'other',
    other,
  );
}

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
void cpu;
