import type { Circuit } from '../sim/Circuit.js';
import type { Level } from '../sim/types.js';

export type SoftCanvasLevel = { level: Level; contended: boolean };

/**
 * Lightweight pin levels for Soft Run at top level (flatten deferred).
 *
 * Soft mode skips transistor step(), so host overrides (lab LED forceOn /
 * Input drivers / Soft Lab softState.q) must paint nets without flatten.
 */
export function makeSoftCanvasResolve(
  circuit: Circuit,
): (pinId: string) => SoftCanvasLevel {
  const nets = circuit.computeNets();
  /** Per net: forced 0/1, or both (contention). */
  const drive = new Map<string, { v: 0 | 1; conflict: boolean }>();

  const push = (pinId: string | undefined, v: 0 | 1): void => {
    if (!pinId) return;
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
    } else if (c.kind === 'chip' && c.softState?.q) {
      const q = c.softState.q;
      for (let i = 0; i < q.length; i++) {
        const pin = c.pins[`q${i}`];
        if (pin) push(pin.id, (q[i]! & 1) as 0 | 1);
      }
      // COUNTER4 terminal count — same formula as softLabDriveOutputs.
      if (c.softState.model === 'COUNTER4' && c.pins.co) {
        const v = (q[0]! | (q[1]! << 1) | (q[2]! << 2) | (q[3]! << 3)) & 0xf;
        push(c.pins.co.id, v === 15 ? 1 : 0);
      }
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
