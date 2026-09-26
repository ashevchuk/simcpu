import type { Circuit } from '../sim/Circuit.js';
import type { Level } from '../sim/types.js';

export type SoftCanvasLevel = { level: Level; contended: boolean };

/**
 * Lightweight pin levels for Soft Run at top level (flatten deferred).
 *
 * Soft mode skips transistor step(), so the old all-Z resolver made every
 * wire look floating while host overrides (lab LED forceOn / Input drivers)
 * still painted indicators — confusing when a LED blinks on a Z wire.
 *
 * Uses only the top circuit's nets + explicit drivers (Input, Source, LED
 * forceOn). No flatten, no Soft Lab chip expansion.
 */
export function makeSoftCanvasResolve(
  circuit: Circuit,
): (pinId: string) => SoftCanvasLevel {
  const nets = circuit.computeNets();
  /** Per net: forced 0/1, or both (contention). */
  const drive = new Map<string, { v: 0 | 1; conflict: boolean }>();

  const push = (pinId: string, v: 0 | 1): void => {
    const net = nets.netOf.get(pinId);
    if (!net) return;
    const cur = drive.get(net);
    if (!cur) drive.set(net, { v, conflict: false });
    else if (cur.v !== v) cur.conflict = true;
  };

  for (const c of circuit.components.values()) {
    if (c.kind === 'input' || c.kind === 'source') {
      push(c.pins.out.id, c.value);
    } else if (c.kind === 'led' && typeof c.forceOn === 'boolean') {
      // Sense-only electrically; Soft host override still paints the net.
      push(c.pins.in.id, c.forceOn ? 1 : 0);
    }
  }

  return (pinId: string): SoftCanvasLevel => {
    const net = nets.netOf.get(pinId);
    if (!net) return { level: 'Z', contended: false };
    const d = drive.get(net);
    if (!d) return { level: 'Z', contended: false };
    if (d.conflict) return { level: d.v, contended: true };
    return { level: d.v, contended: false };
  };
}
