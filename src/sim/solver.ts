import { Circuit } from './Circuit.js';
import { UnionFind } from './UnionFind.js';
import type { Level, NetMap, RamComponent, SimState, TransistorComponent } from './types.js';

/**
 * Switch-level relaxation solver.
 *
 * This is the "Real" engine: it does not treat any gate as a black box.
 * Every transistor is either conducting or not, based on its gate net's
 * *current* resolved level; conducting transistors tie their drain and
 * source nets together into one group. Any such group that is driven by
 * exactly one distinct forced level (from a `source` or `input` component,
 * VCC/GND included — they are just fixed sources) takes that level; a group
 * driven by two conflicting forced levels is a short, flagged as
 * `contended` rather than modeled as an analog voltage, which is outside
 * this simulator's scope.
 *
 * Because a transistor's own conduction can depend on a net whose value
 * depends on that same transistor (feedback — every latch is built this
 * way), one pass is not enough: we iterate, feeding each pass's resolved
 * levels back in as the next pass's gate inputs, until the whole netlist
 * stops changing (a fixpoint) or `maxIterations` is hit.
 *
 * A net with no forced driver in its group keeps its previous value — this
 * models the parasitic capacitance that lets a floating CMOS node
 * "remember" the last level it was driven to, which is exactly how an SR
 * latch built from cross-coupled transistors holds state with no dedicated
 * memory primitive.
 *
 * RamComponent (see types.ts) is the one deliberate exception to "every
 * active device is a transistor" — see "Real RAM" in ARCHITECTURE.md for
 * why. Its read side (`computeRamReadForces`) plugs into this same
 * per-iteration force-resolution as an *additional conditional driver*,
 * exactly like a transistor's conduction: recomputed every pass from the
 * current `levelOf`, because whether it's actually driving (its `oe`) may
 * itself still be settling. Its write side (`applyRamWrites`) is
 * fundamentally different — a `clk` rising edge is a *fact about this tick
 * relative to the previous one*, not something a within-tick relaxation
 * pass can discover — so it runs once, after the loop below has already
 * settled, comparing `prev`'s levels to this call's final ones, and directly
 * mutates the RAM component's own `bytes` (the only side effect anywhere in
 * this file; everything else here computes a new SimState without touching
 * the circuit).
 */
export function step(
  circuit: Circuit,
  netMap: NetMap,
  prev: SimState,
  maxIterations = 64,
): SimState {
  const netIds = [...netMap.pinsOf.keys()];
  const drivers = computeDrivers(circuit, netMap);

  let levelOf = new Map<string, Level>(prev.levelOf);
  for (const id of netIds) if (!levelOf.has(id)) levelOf.set(id, 'Z');

  const transistors: TransistorComponent[] = [];
  const rams: RamComponent[] = [];
  for (const c of circuit.components.values()) {
    if (c.kind === 'transistor') transistors.push(c);
    else if (c.kind === 'ram') rams.push(c);
  }

  let contended = new Set<string>();
  let iterations = 0;
  let changed = true;

  while (changed && iterations < maxIterations) {
    iterations += 1;

    // Union nets connected by currently-conducting transistors.
    const uf = new UnionFind();
    for (const id of netIds) uf.find(id);
    for (const t of transistors) {
      const gateNet = netMap.netOf.get(t.pins.gate.id);
      const gateLevel = gateNet ? levelOf.get(gateNet) : undefined;
      const conducts = t.type === 'N' ? gateLevel === 1 : gateLevel === 0;
      if (!conducts) continue;
      const dNet = netMap.netOf.get(t.pins.drain.id);
      const sNet = netMap.netOf.get(t.pins.source.id);
      if (dNet && sNet) uf.union(dNet, sNet);
    }

    const ramForces = computeRamReadForces(rams, netMap, levelOf);

    const nextLevel = new Map<string, Level>();
    const nextContended = new Set<string>();
    for (const members of uf.groups().values()) {
      const forced = new Set<Level>();
      for (const m of members) {
        const ds = drivers.get(m);
        if (ds) for (const d of ds) forced.add(d);
        const rd = ramForces.get(m);
        if (rd) for (const d of rd) forced.add(d);
      }
      let value: Level;
      if (forced.size > 1) {
        value = 'Z';
        for (const m of members) nextContended.add(m);
      } else if (forced.size === 1) {
        value = [...forced][0] as Level;
      } else {
        // Floating group: capacitive hold of whatever this net settled to before.
        value = levelOf.get(members[0] as string) ?? 'Z';
      }
      for (const m of members) nextLevel.set(m, value);
    }

    changed = false;
    for (const id of netIds) {
      if (levelOf.get(id) !== (nextLevel.get(id) ?? 'Z')) {
        changed = true;
        break;
      }
    }

    levelOf = nextLevel;
    contended = nextContended;
  }

  applyRamWrites(rams, netMap, prev.levelOf, levelOf);

  return { levelOf, contended, settled: !changed, iterations };
}

function netLevel(netMap: NetMap, levelOf: Map<string, Level>, pinId: string): Level | undefined {
  const net = netMap.netOf.get(pinId);
  return net ? levelOf.get(net) : undefined;
}

/** The address this pass's `levelOf` resolves to, or undefined if any address bit isn't concretely 0/1 yet. */
function resolvedAddr(ram: RamComponent, netMap: NetMap, levelOf: Map<string, Level>): number | undefined {
  let addr = 0;
  for (let i = 0; i < ram.addrBits; i++) {
    const lvl = netLevel(netMap, levelOf, ram.pins[`addr${i}`]!.id);
    if (lvl !== 0 && lvl !== 1) return undefined;
    if (lvl === 1) addr |= 1 << i;
  }
  return addr;
}

/**
 * RAM's read side, recomputed every relaxation pass like a transistor's own
 * conduction: while `oe=1` and `we` is not 1 (write mode suppresses the
 * read-drive entirely — real RAM chips define asserting both as invalid,
 * and "don't fight your own write" is the least surprising choice here) and
 * every address bit is concretely resolved, `bytes[addr]` is forced onto
 * the data pins for this pass, exactly like an enabled `buildTriStateBuffer`
 * bank would. An unresolved address (still settling, or never driven at
 * all) drives nothing — the data pins fall back to whatever else drives
 * them, or float, same as a tri-state buffer whose own inputs aren't known
 * yet.
 */
function computeRamReadForces(rams: RamComponent[], netMap: NetMap, levelOf: Map<string, Level>): Map<string, Set<Level>> {
  const forces = new Map<string, Set<Level>>();
  for (const ram of rams) {
    if (netLevel(netMap, levelOf, ram.pins.oe!.id) !== 1) continue;
    if (netLevel(netMap, levelOf, ram.pins.we!.id) === 1) continue;
    const addr = resolvedAddr(ram, netMap, levelOf);
    if (addr === undefined) continue;

    const byte = ram.bytes[addr] ?? 0;
    for (let i = 0; i < ram.dataBits; i++) {
      const net = netMap.netOf.get(ram.pins[`data${i}`]!.id);
      if (!net) continue;
      const bit = ((byte >> i) & 1) as Level;
      const set = forces.get(net);
      if (set) set.add(bit);
      else forces.set(net, new Set([bit]));
    }
  }
  return forces;
}

/**
 * RAM's write side: a `clk` 0/unset -> 1 transition between `prev` (the
 * level going *into* this tick) and `settled` (this tick's final level) —
 * checked once, after relaxation, not per-iteration, because "did an edge
 * just happen" is a fact about two different ticks, not something a single
 * tick's own fixpoint search can discover. On such an edge, if `we=1` and
 * the address is fully resolved, this tick's settled data-pin levels are
 * captured into `bytes[addr]` — an unresolved (floating) data bit writes as
 * 0 rather than aborting the whole write, since "the bus wasn't fully
 * driven at write time" is a real, if sloppy, situation a byte array still
 * has to end up holding *some* concrete value for.
 *
 * This mutates each RamComponent's own `bytes` directly — the only place in
 * this file that mutates the circuit rather than computing a fresh SimState
 * from it. It only matters because `bytes` is the one piece of component
 * state that has to outlive a single `step()` call (see flatten()'s own
 * doc comment for why that's not automatic here).
 */
function applyRamWrites(rams: RamComponent[], netMap: NetMap, prev: Map<string, Level>, settled: Map<string, Level>): void {
  for (const ram of rams) {
    const prevClk = netLevel(netMap, prev, ram.pins.clk!.id) ?? 0;
    const newClk = netLevel(netMap, settled, ram.pins.clk!.id);
    if (prevClk === 1 || newClk !== 1) continue; // no rising edge this tick
    if (netLevel(netMap, settled, ram.pins.we!.id) !== 1) continue;
    const addr = resolvedAddr(ram, netMap, settled);
    if (addr === undefined) continue;

    let byte = 0;
    for (let i = 0; i < ram.dataBits; i++) {
      if (netLevel(netMap, settled, ram.pins[`data${i}`]!.id) === 1) byte |= 1 << i;
    }
    ram.bytes[addr] = byte;
  }
}

// A net id maps to *every* distinct forced level driving it. Almost always
// a singleton set; two entries means two sources/inputs land on the same
// net (whether by a direct wire or by transistors merging them later) —
// exactly the short circuit `step()` needs to detect, so this must not
// collapse multiple drivers on one net down to a single value.
function computeDrivers(circuit: Circuit, netMap: NetMap): Map<string, Set<Level>> {
  const drivers = new Map<string, Set<Level>>();
  for (const c of circuit.components.values()) {
    if (c.kind === 'source' || c.kind === 'input') {
      const net = netMap.netOf.get(c.pins.out.id);
      if (!net) continue;
      const set = drivers.get(net);
      if (set) set.add(c.value);
      else drivers.set(net, new Set([c.value]));
    }
  }
  return drivers;
}

export function initialState(): SimState {
  return { levelOf: new Map(), contended: new Set(), settled: true, iterations: 0 };
}
