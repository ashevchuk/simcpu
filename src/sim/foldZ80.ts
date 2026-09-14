import type { ChipLibrary } from './ChipLibrary.js';
import { fold, type FoldResult } from './hierarchy.js';
import type { Circuit } from './Circuit.js';
import type { Point } from './types.js';

/**
 * After `buildZ80Cpu` places a flat composite, fold every new component
 * except the `RamComponent` into one `Z80CPU` chip instance.
 *
 * Call **after** any external `Input`s (e.g. MachineRunner clocks/seeds)
 * have been wired to the CPU: those Inputs stay on the parent, so their
 * nets become chip ports. RAM stays outside for the same reason `fold()`
 * refuses to fold it (shared `Uint8Array` across ChipDef instances).
 *
 * **Single instance only.** `buildZ80Cpu` uses global `tieToLabel` names
 * (`CLK`, `BUS0`, …) that `flatten()` does not namespace — a second folded
 * Z80 on the same top circuit would short those nets together.
 */
export function foldZ80CpuLeavingRam(
  parent: Circuit,
  library: ChipLibrary,
  placedIds: Iterable<string>,
  instancePos: Point,
  name = 'Z80CPU',
): FoldResult {
  const selected = new Set<string>();
  for (const id of placedIds) {
    const c = parent.components.get(id);
    if (!c) continue;
    if (c.kind === 'ram') continue;
    selected.add(id);
  }
  if (selected.size === 0) {
    throw new Error('foldZ80CpuLeavingRam: no non-RAM components to fold');
  }
  return fold(parent, selected, name, library, instancePos);
}

/** Component ids present in `circuit` but not in `before`. */
export function newComponentIds(circuit: Circuit, before: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const id of circuit.components.keys()) {
    if (!before.has(id)) out.push(id);
  }
  return out;
}
