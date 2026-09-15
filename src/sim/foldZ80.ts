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
 * **Labels:** `flatten()` namespaces non-`VCC`/`GND` label names per chip
 * instance, so multiple folded Z80s no longer short `CLK`/`BUS*`. Still
 * prefer one machine per top circuit for the soft TTY / runner UX.
 */
export function foldZ80CpuLeavingRam(
  parent: Circuit,
  library: ChipLibrary,
  placedIds: Iterable<string>,
  instancePos: Point,
  name = 'Z80CPU',
): FoldResult {
  // Build the selection Set in one pass. Callers often pass `newComponentIds`
  // (already non-existent-before place); we still skip missing/RAM here so
  // fold() does not need a second RAM scan beyond its own safety check.
  const selected = new Set<string>();
  for (const id of placedIds) {
    const c = parent.components.get(id);
    if (c !== undefined && c.kind !== 'ram') selected.add(id);
  }
  if (selected.size === 0) {
    throw new Error('foldZ80CpuLeavingRam: no non-RAM components to fold');
  }
  return fold(parent, selected, name, library, instancePos);
}

/**
 * Component ids present in `circuit` but not in `before`.
 * Prefer {@link newComponentIdSet} when feeding `foldZ80CpuLeavingRam`
 * (avoids an intermediate array of ~40k ids on a 12-bit Z80 place).
 */
export function newComponentIds(circuit: Circuit, before: ReadonlySet<string>): string[] {
  return [...newComponentIdSet(circuit, before)];
}

/** Same as {@link newComponentIds}, but as a Set (cheaper for fold). */
export function newComponentIdSet(circuit: Circuit, before: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const id of circuit.components.keys()) {
    if (!before.has(id)) out.add(id);
  }
  return out;
}
