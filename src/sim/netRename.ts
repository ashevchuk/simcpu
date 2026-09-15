/**
 * Rename (or name) an electrical net by placing/updating LabelComponents.
 * Labels with the same name are joined by Circuit.computeNets — so assigning
 * an existing name also merges nets.
 */

import { bumpStructureVersion, GLOBAL_NET_NAMES, type Circuit } from './Circuit.js';
import { makeLabel } from './library.js';
import type { LabelComponent, Point } from './types.js';

export type RenameNetResult =
  | { ok: true; merged: boolean }
  | { ok: false; reason: string };

/**
 * Apply `newName` to every label on `netId`, or create one label at `anchor`
 * if the net has no labels yet.
 */
export function renameNet(
  circuit: Circuit,
  netId: string,
  newName: string,
  anchor?: Point,
): RenameNetResult {
  const name = newName.trim();
  if (!name) return { ok: false, reason: 'Empty name' };
  if (GLOBAL_NET_NAMES.has(name.toUpperCase()) || GLOBAL_NET_NAMES.has(name)) {
    return { ok: false, reason: 'VCC/GND are reserved global rails' };
  }
  if (netId === 'VCC' || netId === 'GND') {
    return { ok: false, reason: 'Cannot rename the global VCC/GND rail' };
  }

  const netMap = circuit.computeNets();
  const onNet: LabelComponent[] = [];
  for (const c of circuit.components.values()) {
    if (c.kind !== 'label') continue;
    if (netMap.netOf.get(c.pins.net.id) === netId) onNet.push(c);
  }

  // Will this name pull in another net?
  let merged = false;
  for (const c of circuit.components.values()) {
    if (c.kind !== 'label' || c.name !== name) continue;
    const other = netMap.netOf.get(c.pins.net.id);
    if (other && other !== netId) {
      merged = true;
      break;
    }
  }

  if (onNet.length > 0) {
    for (const l of onNet) l.name = name;
    bumpStructureVersion();
    return { ok: true, merged };
  }

  let pos = anchor;
  if (!pos) {
    for (const [pinId, n] of netMap.netOf) {
      if (n !== netId) continue;
      for (const c of circuit.components.values()) {
        for (const p of Object.values(c.pins)) {
          if (p && p.id === pinId) {
            pos = { x: p.pos.x + 20, y: p.pos.y - 20 };
            break;
          }
        }
        if (pos) break;
      }
      if (pos) break;
    }
  }
  if (!pos) return { ok: false, reason: 'Net has no pins' };
  makeLabel(circuit, name, pos);
  return { ok: true, merged };
}

/** Resolve a net id from the current selection / highlighted net / wire. */
export function netIdFromEditorSelection(
  circuit: Circuit,
  opts: {
    highlightedNetId: string | null;
    selectedWireId: string | null;
    selectedIds: Set<string>;
  },
): string | null {
  if (opts.highlightedNetId) return opts.highlightedNetId;
  const netMap = circuit.computeNets();
  if (opts.selectedWireId) {
    const w = circuit.wires.get(opts.selectedWireId);
    if (w) return netMap.netOf.get(w.a) ?? null;
  }
  for (const id of opts.selectedIds) {
    const c = circuit.components.get(id);
    if (!c) continue;
    if (c.kind === 'label') return netMap.netOf.get(c.pins.net.id) ?? null;
    if (c.kind === 'port') return netMap.netOf.get(c.pins.io.id) ?? null;
    if (c.kind === 'probe') return netMap.netOf.get(c.pins.in.id) ?? null;
    const pins = Object.values(c.pins);
    if (pins[0]) return netMap.netOf.get(pins[0].id) ?? null;
  }
  return null;
}
