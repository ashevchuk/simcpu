import type { ChipLibrary } from './ChipLibrary.js';
import { fold, type FoldResult } from './hierarchy.js';
import type { Circuit } from './Circuit.js';
import { CHIP_INSTANCE_WIDTH, chipInstanceHeight, ramPortCount } from './library.js';
import type { Component, Pin, Point } from './types.js';

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
 * Pack the post-fold top view: Z80CPU chip + RAM + seed Inputs + labels.
 *
 * Fold places the chip at `origin`, but RAM (and Inputs parked beside it)
 * still sit at whatever world coords `compactCircuitLayout` left them in —
 * often thousands of units away. Labels stubbed beside pre-fold pins are
 * likewise stranded. This gathers everything into one tight cluster.
 */
export function packFoldedMachine(circuit: Circuit, origin: Point): void {
  const comps = [...circuit.components.values()];
  const chip = comps.find((c) => c.kind === 'chip');
  const ram = comps.find((c) => c.kind === 'ram');
  if (!chip || !ram) return;

  circuit.moveComponent(chip.id, origin.x - chip.pos.x, origin.y - chip.pos.y);

  const chipH = chipInstanceHeight(Object.keys(chip.pins).length);
  const ramH = chipInstanceHeight(ramPortCount(ram));
  const ramX = origin.x + CHIP_INSTANCE_WIDTH / 2 + 80 + CHIP_INSTANCE_WIDTH / 2;
  const ramY = origin.y + (chipH - ramH) / 2;
  circuit.moveComponent(ram.id, ramX - ram.pos.x, ramY - ram.pos.y);

  const inputs = comps.filter((c) => c.kind === 'input').sort((a, b) => a.id.localeCompare(b.id));
  const cols = 6;
  const gridW = (cols - 1) * 44;
  inputs.forEach((inp, i) => {
    const tx = origin.x - CHIP_INSTANCE_WIDTH / 2 - 40 - gridW + (i % cols) * 44;
    const ty = origin.y - chipH / 2 + Math.floor(i / cols) * 32;
    circuit.moveComponent(inp.id, tx - inp.pos.x, ty - inp.pos.y);
  });

  // Rebuild pin maps after moves, then snap each label to the pin it stubs.
  const pinOf = new Map<string, Pin>();
  const ownerOf = new Map<string, Component>();
  for (const c of circuit.components.values()) {
    for (const p of Object.values(c.pins) as Pin[]) {
      pinOf.set(p.id, p);
      ownerOf.set(p.id, c);
    }
  }

  for (const lab of circuit.components.values()) {
    if (lab.kind !== 'label') continue;
    let anchor: Pin | null = null;
    for (const w of circuit.wires.values()) {
      let otherId: string | null = null;
      if (w.a === lab.pins.net.id) otherId = w.b;
      else if (w.b === lab.pins.net.id) otherId = w.a;
      if (!otherId) continue;
      const owner = ownerOf.get(otherId);
      if (!owner || owner.kind === 'label') continue;
      if (owner.kind === 'chip' || owner.kind === 'ram' || owner.kind === 'input' || owner.kind === 'source') {
        anchor = pinOf.get(otherId) ?? null;
        break;
      }
    }
    if (!anchor) continue;
    circuit.moveComponent(lab.id, anchor.pos.x + 8 - lab.pos.x, anchor.pos.y - lab.pos.y);
  }
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
