import type { ChipDef, ChipLibrary } from './ChipLibrary.js';
import { bumpStructureVersion, Circuit, currentStructureVersion, GLOBAL_NET_NAMES, nextId } from './Circuit.js';
import { makeChipInstance, makeInput, makePort, makeProbe, makeSource } from './library.js';
import type { ChipInstanceComponent, Component, InputComponent, Pin, Point, SourceComponent } from './types.js';

export interface FoldResult {
  def: ChipDef;
  instance: ChipInstanceComponent;
}

/**
 * Convenience wrapper around fold() for building a ChipDef entirely in
 * code (used by blocks.ts, and by the hierarchy/fold test suite) instead
 * of via the UI's Ctrl+G.
 *
 * fold() only turns a net into a port if it *crosses the selection
 * boundary* (see fold()'s own doc comment) — a freshly-wired gate's
 * exposed pins have no such crossing wire yet, so nothing would become a
 * port. This wires each of `exposedPins` to a throwaway Input (for an
 * input pin) or Probe (for an output pin) left *outside* the selection —
 * forcing that net to cross the boundary, in the given order — then folds
 * everything else in `scratch` and discards the stubs along with it.
 */
export function foldExposing(
  scratch: Circuit,
  name: string,
  library: ChipLibrary,
  exposedPins: { pin: Pin; isOutput: boolean }[],
): ChipDef {
  const stubIds = new Set<string>();
  for (const { pin, isOutput } of exposedPins) {
    if (isOutput) {
      const stub = makeProbe(scratch);
      stubIds.add(stub.id);
      scratch.addWire(pin.id, stub.pins.in.id);
    } else {
      const stub = makeInput(scratch, 0);
      stubIds.add(stub.id);
      scratch.addWire(stub.pins.out.id, pin.id);
    }
  }
  const guts = new Set<string>();
  for (const id of scratch.components.keys()) if (!stubIds.has(id)) guts.add(id);
  return fold(scratch, guts, name, library, { x: 0, y: 0 }).def;
}

/**
 * Rename one port of a chip definition (double-click a port while dived
 * into a chip, per the reference project's "Ports & labels: double-click to
 * rename"). This has to reach further than the single `PortComponent` being
 * renamed: `def.ports` is an ordered list of *names*, keyed on to build
 * every placed instance's `pins` record (see makeChipInstance in
 * library.ts) — so every existing instance of this def, wherever it lives,
 * needs that key renamed too, or its pin would silently vanish from view
 * under its old name.
 *
 * Wires never need touching: they reference `Pin.id`, which never changes
 * here — only the record key and the pin's own `.name` do.
 *
 * `allCircuits` must include every circuit that could contain an instance
 * of this def: the top-level circuit plus every ChipDef's own circuit
 * (an instance can live inside another chip's internals too).
 */
export function renamePort(
  library: ChipLibrary,
  allCircuits: Circuit[],
  defId: string,
  oldName: string,
  newName: string,
): boolean {
  if (newName === oldName) return true;
  const def = library.get(defId);
  if (def.ports.includes(newName)) return false; // name collision

  const idx = def.ports.indexOf(oldName);
  if (idx === -1) return false;
  def.ports[idx] = newName;

  for (const c of def.circuit.components.values()) {
    if (c.kind === 'port' && c.name === oldName) c.name = newName;
  }

  for (const circuit of allCircuits) {
    for (const c of circuit.components.values()) {
      if (c.kind !== 'chip' || c.defId !== defId) continue;
      const pin = c.pins[oldName];
      if (!pin) continue;
      pin.name = newName;
      delete c.pins[oldName];
      c.pins[newName] = pin;
    }
  }
  // None of the mutations above go through Circuit's own tracked methods
  // (addComponent/addWire/etc, the ones that bump the shared structure
  // version for flatten()'s own cache — see hierarchy.ts's flatten()) —
  // this rewrites `.name`/`.pins` keys directly. A stale cache from before
  // a rename wouldn't break simulation (port names carry no electrical
  // meaning), but an explicit bump costs nothing for an operation this rare.
  bumpStructureVersion();
  return true;
}

/**
 * Fold a set of components (Ctrl+G in the UI) into a reusable chip: the
 * selection is cut out of `parent` into a fresh internal Circuit, registered
 * in `library`, and replaced in `parent` by one ChipInstanceComponent.
 *
 * Any net that has pins both inside and outside the selection becomes a
 * numbered port, in first-encountered order. VCC/GND are the one exception:
 * per the reference project's spec, they're a global rail available inside
 * every chip with no explicit port ("Power flows into chips over the global
 * VCC/GND rails automatically") — so a crossing VCC/GND net instead gets a
 * fresh local `source` component wired in on the inside. That makes every
 * folded chip self-powered on its own, and flatten() (below) still reunites
 * every VCC/GND source system-wide once the whole hierarchy is simulated,
 * for free, via Circuit.computeNets()'s existing global name-based merge —
 * no extra plumbing needed.
 *
 * Known limitation: this assumes a selection's internal share of any
 * crossing net is already connected *within* the selection (by a wire that
 * itself stays fully inside). A net that would only stay connected by
 * routing back out through the unselected part of the circuit is not
 * supported — an unusual topology in practice, not worth the complexity
 * it would add here.
 */
export function fold(
  parent: Circuit,
  selectedIds: Set<string>,
  name: string,
  library: ChipLibrary,
  instancePos: Point,
): FoldResult {
  if (selectedIds.size === 0) throw new Error('cannot fold an empty selection');
  // `parent.components.delete(id)`/`parent.wires.delete(w.id)` below are
  // raw Map mutations, bypassing Circuit's own removeComponent()/
  // removeWire() (needed here since fold() moves entries into `internal`
  // rather than discarding them) — every one of those bypasses the bump
  // those tracked methods would otherwise do. In practice this function
  // always ends up bumping anyway, incidentally, through `internal`'s own
  // addComponent()/addWire() calls and `parent`'s own addWire() for
  // reconnected crossing wires below (the shared counter doesn't care
  // which Circuit's tracked method fired it) — but relying on that
  // incidental coverage staying true through some future edit of this
  // function is exactly the kind of assumption that quietly rots. One
  // explicit bump here costs nothing and makes it not matter either way.
  bumpStructureVersion();
  for (const id of selectedIds) {
    // A folded chip's internal circuit is one shared template every
    // instance's flatten() expands from — fine for transistors (each
    // instance's *simulated* nets are still independent, per-instance-path
    // namespaced), wrong for RAM, whose actual state lives in one Uint8Array
    // by reference (see flattenLevel's own comment on why). Every instance
    // of a folded RAM chip would silently share that one array. Rather than
    // let that footgun through, RAM simply can't be folded — see
    // ARCHITECTURE.md's "Real RAM" for the reasoning.
    if (parent.components.get(id)?.kind === 'ram') {
      throw new Error('RAM cannot be folded into a chip — each instance would share the same memory. Wire it directly instead.');
    }
  }

  const netMap = parent.computeNets(); // must run before any mutation below
  const ownerOf = new Map<string, string>();
  for (const p of parent.allPins()) ownerOf.set(p.id, p.componentId);
  const isSelected = (pinId: string) => selectedIds.has(ownerOf.get(pinId) ?? '');

  const internal = new Circuit();
  for (const id of selectedIds) {
    const c = parent.components.get(id);
    if (!c) throw new Error(`selected component not found: ${id}`);
    parent.components.delete(id);
    internal.addComponent(c);
  }

  const ports: string[] = [];
  const portByNet = new Map<string, { name: string; ioPinId: string }>();
  const pendingOutsideWires: { outsidePinId: string; portName: string }[] = [];

  for (const w of [...parent.wires.values()]) {
    const aIn = isSelected(w.a);
    const bIn = isSelected(w.b);
    if (aIn && bIn) {
      // Fully inside: moves into the chip's internals verbatim.
      parent.wires.delete(w.id);
      internal.addWire(w.a, w.b);
      continue;
    }
    if (!aIn && !bIn) continue; // fully outside the selection, untouched

    const insidePinId = aIn ? w.a : w.b;
    const outsidePinId = aIn ? w.b : w.a;
    const netId = netMap.netOf.get(insidePinId);
    parent.wires.delete(w.id);

    if (netId === 'VCC' || netId === 'GND') {
      const src = makeSource(internal, netId === 'VCC' ? 1 : 0);
      internal.addWire(insidePinId, src.pins.out.id);
      continue;
    }

    let entry = netId ? portByNet.get(netId) : undefined;
    if (!entry) {
      const portName = `p${ports.length}`;
      // Positive x: the canvas can't scroll to negative coordinates, so a
      // freshly-folded chip's internals must open with its ports on-screen.
      const port = makePort(internal, portName, { x: 40, y: 80 + ports.length * 40 });
      entry = { name: portName, ioPinId: port.pins.io.id };
      ports.push(portName);
      if (netId) portByNet.set(netId, entry);
    }
    // Wire *every* crossing wire's inside pin to the port, not just the
    // first — a net can fan in from several inside pins that are only
    // mutually connected via the outside world at all (before folding),
    // e.g. one external line driving several separate internal gates.
    internal.addWire(insidePinId, entry.ioPinId);
    pendingOutsideWires.push({ outsidePinId, portName: entry.name });
  }

  const def: ChipDef = { id: nextId('chipdef'), name, ports, circuit: internal };
  library.register(def);

  const instance = makeChipInstance(parent, def, instancePos);
  for (const { outsidePinId, portName } of pendingOutsideWires) {
    const instancePin = instance.pins[portName];
    if (instancePin) parent.addWire(outsidePinId, instancePin.id);
  }

  return { def, instance };
}

interface FlatLevel {
  components: Component[];
  wires: { id: string; a: string; b: string }[];
  liveValuePairs: LiveValuePair[];
}

/**
 * `SourceComponent.value`/`InputComponent.value` are the one other piece of
 * runtime-mutable state besides RAM's own `.bytes` (see flattenLevel's own
 * comment on that) — a toggleable input's whole reason to exist is getting
 * flipped between ticks, by direct field assignment (`input.value = 1`),
 * never through a Circuit method, so it never bumps the structure version
 * and never invalidates flatten()'s own cache (correctly — flipping an
 * input doesn't change the *netlist*, only what's forced onto one of its
 * existing nets). A cached flat clone's own `.value` copy, though, is
 * frozen at whatever it was the moment that clone was built — every pair
 * collected here exists so a cache *hit* can still cheaply re-copy each
 * clone's `.value` from its original before handing the result back,
 * rather than serving a stale toggle forever.
 */
interface LiveValuePair {
  original: SourceComponent | InputComponent;
  clone: SourceComponent | InputComponent;
}

/**
 * Recursively expand every chip instance in `top` into its transistor-level
 * guts, producing one flat Circuit that solver.ts can simulate completely
 * unchanged — hierarchy is purely a structural/editing convenience, nothing
 * about the solver needs to know chips exist.
 *
 * Every id gets namespaced per instance path (`${instanceId}/${...}`, deep
 * for nested chips) so that two instances of the same ChipDef get fully
 * independent internal nets — essential, since a ChipDef's `circuit` is
 * shared by every instance for *editing*, but each instance's *simulated*
 * state must not be shared. The one deliberate exception: a port's `io`
 * pin is aliased onto the exact pin id the instance already uses for that
 * port at the level above, so wires drawn to the instance resolve straight
 * through with no extra step. VCC/GND sources are never namespaced
 * specially at all — see the note on fold() above for why that is exactly
 * the global-rail behavior we want.
 */
/**
 * Cached per top-level Circuit, keyed on the shared structural-version
 * counter (see Circuit.ts's bumpStructureVersion/currentStructureVersion):
 * flatten() is called once per tick — every animation frame in the live
 * app (see main.ts's frame()), once per pulse() in every buildZ80Cpu test
 * — and its own cost (cloning every component, recursively
 * through the whole hierarchy) had nothing to do with whether anything
 * actually changed since the last call. The overwhelming majority of
 * calls, in both the live app and every test, happen between edits, not
 * during one: toggling an input, pulsing a clock, or just letting
 * requestAnimationFrame tick idly never touches a single wire or
 * component. This cache turns every one of those into a WeakMap lookup
 * and a version-number comparison, at the cost of one wrong assumption
 * this file must never make: that the version bumped by flatten()'s own
 * output-building (`out`'s components/wires) could safely be told apart
 * from a version bump caused by an actual user edit somewhere in `top`'s
 * hierarchy. It can't, cheaply — so `out` is built entirely from
 * addRawComponent()/addRawWire(), which don't bump the counter at all,
 * exactly the reason those two exist.
 */
const flattenCache = new WeakMap<Circuit, { version: number; result: Circuit; liveValuePairs: LiveValuePair[] }>();

/**
 * Fully-expanded ChipDef flatten at prefix `''`, keyed by the def's own
 * `circuit` + structureVersion. Multiple instances of the same def (the
 * common case inside a folded Z80: thousands of identical gate chips)
 * rebase this template with `nsPrefix` instead of re-walking nested chips.
 */
const chipDefFlatCache = new WeakMap<Circuit, { version: number; flat: FlatLevel }>();
/** How many times flattenChipDef has been asked to expand this def.circuit. */
const chipDefFlatRequestCount = new WeakMap<Circuit, number>();

export function flatten(top: Circuit, library: ChipLibrary): Circuit {
  const version = currentStructureVersion();
  const cached = flattenCache.get(top);
  if (cached && cached.version === version) {
    // The netlist itself hasn't changed, but a toggleable input's own
    // `.value` — the one piece of state this version check can't see (see
    // LiveValuePair's own doc comment) — might have, since the caller's
    // very last tick. Cheap regardless: a handful of pairs, not a
    // clone of the whole hierarchy.
    for (const { original, clone } of cached.liveValuePairs) clone.value = original.value;
    return cached.result;
  }

  const { components, wires, liveValuePairs } = flattenLevel(top, library, '');
  const out = new Circuit();
  for (const c of components) out.addRawComponent(c);
  for (const w of wires) out.addRawWire(w);

  flattenCache.set(top, { version, result: out, liveValuePairs });
  return out;
}

/** Clone a Pin; only the four own fields — no prototype / exotic junk. */
function clonePin(p: Pin): Pin {
  return { id: p.id, componentId: p.componentId, name: p.name, pos: { x: p.pos.x, y: p.pos.y } };
}

function clonePinsRecord(pins: Record<string, Pin>): Record<string, Pin> {
  const out: Record<string, Pin> = Object.create(null);
  for (const key in pins) {
    const p = pins[key];
    if (p) out[key] = clonePin(p);
  }
  return out;
}

/**
 * Fast structural clone for flatten. Prefer this over `structuredClone`:
 * for ~200k transistor-level components the latter dominates cold flatten
 * (copies far more than the simulator needs). RAM `.bytes` is aliased on
 * purpose — same contract the old structuredClone + re-point path had.
 */
function cloneComponent(c: Component): Component {
  const pos = { x: c.pos.x, y: c.pos.y };
  switch (c.kind) {
    case 'transistor':
      return {
        id: c.id,
        kind: 'transistor',
        type: c.type,
        pos,
        rotation: c.rotation,
        pins: {
          gate: clonePin(c.pins.gate),
          drain: clonePin(c.pins.drain),
          source: clonePin(c.pins.source),
        },
      };
    case 'source':
      return { id: c.id, kind: 'source', value: c.value, pos, pins: { out: clonePin(c.pins.out) } };
    case 'input':
      return { id: c.id, kind: 'input', value: c.value, pos, pins: { out: clonePin(c.pins.out) } };
    case 'probe':
      return {
        id: c.id,
        kind: 'probe',
        ...(c.label !== undefined ? { label: c.label } : {}),
        pos,
        pins: { in: clonePin(c.pins.in) },
      };
    case 'label':
      return { id: c.id, kind: 'label', name: c.name, pos, pins: { net: clonePin(c.pins.net) } };
    case 'port':
      return { id: c.id, kind: 'port', name: c.name, pos, pins: { io: clonePin(c.pins.io) } };
    case 'ram':
      // Alias `.bytes` — writes must survive the next flatten (see flattenLevel).
      return {
        id: c.id,
        kind: 'ram',
        addrBits: c.addrBits,
        dataBits: c.dataBits,
        bytes: c.bytes,
        pos,
        pins: clonePinsRecord(c.pins),
      };
    case 'chip':
      return { id: c.id, kind: 'chip', defId: c.defId, pos, pins: clonePinsRecord(c.pins) };
  }
}

/**
 * Apply an instance-path prefix to a FlatLevel that was expanded at `''`
 * (or any shorter prefix). Does not mutate `src` — the ChipDef cache holds
 * the template. Label names: non-global names get the prefix; VCC/GND stay.
 */
function rebaseFlat(src: FlatLevel, prefix: string): FlatLevel {
  if (!prefix) {
    // Protect the cache: callers must not share template object identity
    // with a live flatten result.
    return rebaseFlatCopy(src);
  }
  const components: Component[] = new Array(src.components.length);
  const templateToClone = new Map<Component, Component>();
  for (let i = 0; i < src.components.length; i++) {
    const c = src.components[i]!;
    const clone = cloneComponent(c);
    clone.id = prefix + c.id;
    if (clone.kind === 'label' && !GLOBAL_NET_NAMES.has(clone.name)) {
      clone.name = prefix + clone.name;
    }
    for (const p of Object.values(clone.pins as unknown as Record<string, Pin>)) {
      p.id = prefix + p.id;
      p.componentId = clone.id;
    }
    components[i] = clone;
    templateToClone.set(c, clone);
  }
  const wires = new Array<{ id: string; a: string; b: string }>(src.wires.length);
  for (let i = 0; i < src.wires.length; i++) {
    const w = src.wires[i]!;
    wires[i] = { id: prefix + w.id, a: prefix + w.a, b: prefix + w.b };
  }
  const liveValuePairs: LiveValuePair[] = new Array(src.liveValuePairs.length);
  for (let i = 0; i < src.liveValuePairs.length; i++) {
    const { original, clone: templateClone } = src.liveValuePairs[i]!;
    liveValuePairs[i] = {
      original,
      clone: templateToClone.get(templateClone) as SourceComponent | InputComponent,
    };
  }
  return { components, wires, liveValuePairs };
}

/** Deep-enough copy with no id renaming (cache isolation when prefix is ''). */
function rebaseFlatCopy(src: FlatLevel): FlatLevel {
  const components: Component[] = new Array(src.components.length);
  const templateToClone = new Map<Component, Component>();
  for (let i = 0; i < src.components.length; i++) {
    const c = src.components[i]!;
    const clone = cloneComponent(c);
    components[i] = clone;
    templateToClone.set(c, clone);
  }
  const wires = src.wires.map((w) => ({ id: w.id, a: w.a, b: w.b }));
  const liveValuePairs: LiveValuePair[] = src.liveValuePairs.map(({ original, clone: tc }) => ({
    original,
    clone: templateToClone.get(tc) as SourceComponent | InputComponent,
  }));
  return { components, wires, liveValuePairs };
}

/**
 * Expand one ChipDef instance at `prefix`.
 *
 * Warm path: rebase a cached fully-expanded template (prefix `''`) so
 * thousands of identical gate instances don't re-walk nested chips.
 *
 * Cold path: the first request for a given def expands directly at
 * `prefix` (one clone pass — important for a one-off folded Z80). The
 * second request builds and stores the `''` template, then rebases; later
 * requests only rebase.
 */
function flattenChipDef(def: ChipDef, library: ChipLibrary, prefix: string): FlatLevel {
  const version = currentStructureVersion();
  const hit = chipDefFlatCache.get(def.circuit);
  if (hit && hit.version === version) {
    return rebaseFlat(hit.flat, prefix);
  }

  const prev = chipDefFlatRequestCount.get(def.circuit) ?? 0;
  const next = prev + 1;
  chipDefFlatRequestCount.set(def.circuit, next);

  if (next >= 2) {
    const template = flattenLevel(def.circuit, library, '');
    chipDefFlatCache.set(def.circuit, { version, flat: template });
    return rebaseFlat(template, prefix);
  }
  return flattenLevel(def.circuit, library, prefix);
}

function flattenLevel(circuit: Circuit, library: ChipLibrary, nsPrefix: string): FlatLevel {
  const idMap = new Map<string, string>(); // this level's original pin id -> namespaced pin id
  const outComponents: Component[] = [];
  const outWires: { id: string; a: string; b: string }[] = [];
  const outLiveValuePairs: LiveValuePair[] = [];

  for (const c of circuit.components.values()) {
    // Registered for every kind, chip instances included: sibling wires at
    // this level may target a chip instance's own (unexpanded) pins, and
    // those ids need the same namespacing as everything else here.
    for (const p of Object.values(c.pins) as Pin[]) idMap.set(p.id, nsPrefix + p.id);
  }

  for (const c of circuit.components.values()) {
    if (c.kind === 'chip') continue; // expanded in the loop below, not copied directly
    const clone = cloneComponent(c);
    // RAM `.bytes` is already aliased by cloneComponent. Writes during
    // step() must remain visible after the next flatten — see ARCHITECTURE.md
    // "Real RAM". StructuredClone used to copy the Uint8Array; we never do.
    if (c.kind === 'source' || c.kind === 'input') {
      outLiveValuePairs.push({ original: c, clone: clone as SourceComponent | InputComponent });
    }
    clone.id = nsPrefix + c.id;
    // Named ties (CLK, BUS0, …) would otherwise short across chip instances
    // after flatten — computeNets joins same-named labels. VCC/GND stay
    // global on purpose. Top-level (empty nsPrefix) keeps names as authored.
    if (clone.kind === 'label' && nsPrefix && !GLOBAL_NET_NAMES.has(clone.name)) {
      clone.name = `${nsPrefix}${clone.name}`;
    }
    for (const p of Object.values(clone.pins as unknown as Record<string, Pin>)) {
      p.id = idMap.get(p.id) ?? p.id;
      p.componentId = clone.id;
    }
    outComponents.push(clone);
  }

  for (const w of circuit.wires.values()) {
    outWires.push({ id: nsPrefix + w.id, a: idMap.get(w.a) ?? w.a, b: idMap.get(w.b) ?? w.b });
  }

  for (const c of circuit.components.values()) {
    if (c.kind !== 'chip') continue;
    const def = library.get(c.defId);
    const child = flattenChipDef(def, library, `${nsPrefix}${c.id}/`);

    const portAlias = new Map<string, string>();
    for (const ic of child.components) {
      if (ic.kind !== 'port') continue;
      const externalPin = c.pins[ic.name];
      if (externalPin) portAlias.set(ic.pins.io.id, idMap.get(externalPin.id) ?? externalPin.id);
    }

    for (const ic of child.components) {
      if (ic.kind === 'port') continue; // boundary marker only, no electrical role
      outComponents.push(ic);
    }
    for (const w of child.wires) {
      outWires.push({ id: w.id, a: portAlias.get(w.a) ?? w.a, b: portAlias.get(w.b) ?? w.b });
    }
    outLiveValuePairs.push(...child.liveValuePairs);
  }

  return { components: outComponents, wires: outWires, liveValuePairs: outLiveValuePairs };
}
