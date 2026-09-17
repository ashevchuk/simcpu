/**
 * Pure helpers for lab instruments — tick pulse generators / release scripted
 * momentary button holds. Pointer-held momentaries are owned by Editor
 * (mousedown → 1, mouseup → 0) and do not use holdFrames.
 * Called from main.ts whenever the frame already simulates, and every frame while
 * `circuitNeedsLabTick` (running clocks, decaying holds, armed analyzers).
 */

import type { Circuit } from './Circuit.js';
import type { Level, NetMap } from './types.js';

function pinLevel(
  pinId: string,
  netMap: NetMap | undefined,
  levelOf: Map<string, Level> | undefined,
): Level {
  if (!netMap || !levelOf) return 'Z';
  const net = netMap.netOf.get(pinId);
  if (!net) return 'Z';
  return levelOf.get(net) ?? 'Z';
}

/**
 * True when instruments need wall-clock frames (not only opportunistic ticks
 * during an already-scheduled sim draw): a running/oneshot pulse gen, a
 * decaying scripted momentary button hold, or an armed analyzer.
 */
export function circuitNeedsLabTick(circuit: Circuit, analyzerArmed = false): boolean {
  if (analyzerArmed) return true;
  for (const c of circuit.components.values()) {
    if (c.kind === 'clock' && (c.running || c.holdFrames > 0)) return true;
    if (c.kind === 'button' && c.mode === 'momentary' && c.holdFrames > 0) return true;
  }
  return false;
}

/** Advance pulse gens / decay holds. Returns true if any driver value changed. */
export function tickLabInstruments(
  circuit: Circuit,
  netMap?: NetMap,
  levelOf?: Map<string, Level>,
): boolean {
  let changed = false;
  for (const c of circuit.components.values()) {
    if (c.kind === 'button' && c.mode === 'momentary' && c.holdFrames > 0) {
      c.holdFrames -= 1;
      if (c.holdFrames <= 0 && c.value !== 0) {
        c.value = 0;
        c.holdFrames = 0;
        changed = true;
      }
    } else if (c.kind === 'clock') {
      const trigNow = pinLevel(c.pins.trig.id, netMap, levelOf);
      const trigRise = c.lastTrig !== 1 && trigNow === 1;
      c.lastTrig = trigNow;

      if (c.mode === 'oneshot') {
        if (trigRise) {
          c.holdFrames = Math.max(1, c.dutyFrames);
          if (c.value !== 1) {
            c.value = 1;
            changed = true;
          }
        } else if (c.holdFrames > 0) {
          c.holdFrames -= 1;
          if (c.holdFrames <= 0 && c.value !== 0) {
            c.value = 0;
            c.holdFrames = 0;
            changed = true;
          }
        }
      } else {
        // continuous
        if (trigRise) c.running = true;
        if (!c.running) continue;
        const next: 0 | 1 = c.phase < c.dutyFrames ? 1 : 0;
        if (c.value !== next) {
          c.value = next;
          changed = true;
        }
        c.phase = (c.phase + 1) % c.periodFrames;
      }
    }
  }
  return changed;
}

/** Fire a one-shot pulse on a pulse-generator (used by click / dialog "Fire"). */
export function firePulse(c: {
  mode: string;
  dutyFrames: number;
  holdFrames: number;
  value: 0 | 1;
  running: boolean;
  phase: number;
}): void {
  if (c.mode === 'oneshot') {
    c.holdFrames = Math.max(1, c.dutyFrames);
    c.value = 1;
  } else {
    c.running = !c.running;
    if (!c.running) c.phase = 0;
  }
}
