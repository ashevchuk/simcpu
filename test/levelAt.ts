import type { Level, NetMap, SimState } from '../src/sim/types.js';

/**
 * Shared by every `buildZ80Cpu` test file (see "Splitting the slow tests
 * across files" in ARCHITECTURE.md for why they're separate files at all —
 * vitest parallelizes across files, not across `it()`s within one, and
 * these are the composite's own genuinely slow tests). Pulled out once
 * here instead of copy-pasted into all eight, so there's a single place to
 * fix if `netMap`'s own shape ever changes.
 */
export function levelAt(state: SimState, netMap: NetMap, pinId: string): Level {
  const net = netMap.netOf.get(pinId);
  if (!net) throw new Error(`unknown pin ${pinId}`);
  return state.levelOf.get(net) ?? 'Z';
}
