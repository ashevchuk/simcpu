import type { ChipLibrary } from '../sim/ChipLibrary.js';
import { Circuit, nextId } from '../sim/Circuit.js';
import {
  makeAnalyzer,
  makeBusProbe,
  makeBusSwitch,
  makeButton,
  makeChipInstance,
  makeClock,
  makeInput,
  makeJunction,
  makeLabel,
  makeLed,
  makePort,
  makeProbe,
  makeSevenSeg,
  makeSource,
  makeTransistor,
  makeTty,
  nextAutoPortName,
  parseBusPortSpec,
  relayoutBusProbePins,
  relayoutBusSwitchPins,
} from '../sim/library.js';
import { firePulse } from '../sim/labTick.js';
import { applyPinLayout, syncPinSidesFromDef } from '../sim/orientation.js';
import { captureCircuit, type CircuitSnapshot } from '../sim/serialize.js';
import type { ChipInstanceComponent, Component, Pin, Point } from '../sim/types.js';
import { showPrompt } from './Dialog.js';
import type { TutorialHint } from './Tutorial.js';
import {
  busSwitchBitAt,
  dist,
  findComponentNear,
  findPinNear,
  findWaypointNear,
  findWireNear,
  GRID,
  interiorWaypoints,
  nearestOnPolyline,
  pinExitDir,
  rawWirePolyline,
  routeWirePoints,
  routingObstacles,
  snap,
  wirePolyline,
} from './geometry.js';

export type SnapMode = 'grid' | 'half' | 'free';

export type Tool =
  | { kind: 'select' }
  | { kind: 'pan' } // dedicated hand tool; space+drag / right-drag also pan regardless of tool, see main.ts
  | { kind: 'wire' }
  | { kind: 'nmos' }
  | { kind: 'pmos' }
  | { kind: 'vcc' }
  | { kind: 'gnd' }
  | { kind: 'input' }
  | { kind: 'button' }
  | { kind: 'led' }
  | { kind: 'sevenseg' }
  | { kind: 'clock' }
  | { kind: 'analyzer' }
  | { kind: 'busprobe' }
  | { kind: 'busswitch' }
  | { kind: 'tty' }
  | { kind: 'probe' }
  | { kind: 'label' }
  | { kind: 'port'; promptName?: boolean }
  | { kind: 'place-chip'; defId: string }; // place an instance of an existing ChipDef

const DRAG_THRESHOLD = 4; // px of mouse movement before a mousedown becomes a drag, not a click

/**
 * Owns the editing state that sits on top of a Circuit: the active tool, an
 * in-progress wire, the current selection (components and/or one wire), a
 * marquee/waypoint drag in progress, hover state (for cursor feedback in
 * the Renderer), and the last mouse position (for rubber-bands). All
 * simulation state lives elsewhere (main.ts's animation loop); all
 * camera/pan/zoom state lives in main.ts too (see Camera.ts) — every Point
 * this class receives or returns is already in *world* space, converted by
 * main.ts before the call.
 *
 * main.ts forwards raw mouse events nearly unconditionally
 * (mousedown/mousemove/mouseup); this class alone decides whether a given
 * mouseup ends a drag (marquee-select, dragging a wire's bend point) or
 * should instead be treated as a plain click (select/toggle/place/wire-tool
 * routing) — see handleMouseUp() and the private performClick() it calls.
 *
 * `circuit` is reassigned, not fixed, because diving into a chip instance's
 * internals (see main.ts's navigation stack) points the same Editor at a
 * different Circuit — the tool state (selection, pending wire) is cleared
 * on that switch by main.ts, but the Editor instance itself is reused.
 */
export class Editor {
  circuit: Circuit;
  tool: Tool = { kind: 'select' };
  wireStartPinId: string | null = null;
  /** Bend points committed so far for the wire currently being drawn, in order from the start pin. Cosmetic only — see Wire in types.ts. */
  wireWaypoints: Point[] = [];
  selectedIds = new Set<string>();
  /** Selected wires (marquee can take several; click selects one). */
  selectedWireIds = new Set<string>();
  /** Net id (from Circuit.computeNets) to highlight — set when selecting a wire or pressing H. */
  highlightedNetId: string | null = null;
  mouse: Point = { x: 0, y: 0 };
  marqueeStart: Point | null = null;
  dragging = false;
  hoveredComponentId: string | null = null;
  hoveredPinId: string | null = null;
  hoveredWireId: string | null = null;
  /** Set by main.ts — push undo checkpoint before mutating edits. */
  onBeforeEdit: (() => void) | null = null;
  /** Fired after components are removed (Delete / context menu), with their ids. */
  onComponentsRemoved: ((ids: string[]) => void) | null = null;
  /** In-canvas tutorial highlight target (Renderer + Place menu). */
  tutorialHint: TutorialHint = null;
  private clipboard: CircuitSnapshot | null = null;
  /** True once per drag gesture after the first real move (undo checkpoint). */
  private dragCheckpointTaken = false;

  /** An existing bend point currently being dragged. */
  private dragWaypoint: { wireId: string; index: number } | null = null;
  /** Mousedown landed on a wire segment (not an existing bend point) — becomes a real inserted waypoint only past DRAG_THRESHOLD, so a plain click just selects the wire instead of kinking it. */
  private pendingWireGrab: { wireId: string; insertIndex: number; downPoint: Point } | null = null;
  /** Mousedown landed on a component — becomes an actual move only past DRAG_THRESHOLD, so a plain click still just (multi-)selects/toggles it. */
  private pendingComponentDrag: { ids: string[]; downPoint: Point } | null = null;
  /** The component(s) actually being dragged right now, and where the pointer was last frame (moves are applied as deltas, never absolute jumps). */
  private draggingComponents: { ids: string[]; lastPoint: Point } | null = null;
  /** Drag a chip pin across the body center to flip left/right stack (Alt/Shift+drag). */
  private pinSideDrag: { componentId: string; pinName: string; startX: number } | null = null;

  /** Placement / move / wire bend snap: full grid, half grid, or free. Cycle with G. */
  snapMode: SnapMode = 'grid';

  /** True while a component or a wire's bend point is being actively dragged — for cursor feedback, see main.ts. */
  get isDragging(): boolean {
    return this.draggingComponents !== null || this.dragWaypoint !== null;
  }

  /** Snap a world point according to `snapMode`, then magnet to nearby pin axes. */
  getSnap(p: Point): Point {
    let s: Point;
    if (this.snapMode === 'free') s = { x: p.x, y: p.y };
    else if (this.snapMode === 'half') s = snap(p, GRID / 2);
    else s = snap(p);

    // Pull X/Y onto nearby pin columns/rows so chip pin pitches (often 20)
    // stay reachable even when bends snap to the finer GRID.
    const magnet = GRID * 1.25;
    let bestX = s.x;
    let bestY = s.y;
    let bestXd = magnet;
    let bestYd = magnet;
    for (const pin of this.circuit.allPins()) {
      const dx = Math.abs(pin.pos.x - p.x);
      const dy = Math.abs(pin.pos.y - p.y);
      if (dx < bestXd) {
        bestXd = dx;
        bestX = pin.pos.x;
      }
      if (dy < bestYd) {
        bestYd = dy;
        bestY = pin.pos.y;
      }
    }
    if (bestXd < magnet) s = { x: bestX, y: s.y };
    if (bestYd < magnet) s = { x: s.x, y: bestY };
    return s;
  }

  /** Cycle grid → half → free → grid. Returns the new mode. */
  cycleSnapMode(): SnapMode {
    this.snapMode = this.snapMode === 'grid' ? 'half' : this.snapMode === 'half' ? 'free' : 'grid';
    return this.snapMode;
  }

  /**
   * Snap VCC/GND placement/drag Y onto a nearby same-value rail (within GRID).
   * Returns the magnet Y, or `y` unchanged when nothing is close.
   */
  magnetSourceRailY(value: 0 | 1, y: number, excludeId?: string): number {
    let bestY = y;
    let bestDist = GRID;
    for (const c of this.circuit.components.values()) {
      if (c.kind !== 'source' || c.value !== value) continue;
      if (excludeId && c.id === excludeId) continue;
      const d = Math.abs(c.pos.y - y);
      if (d <= bestDist) {
        bestDist = d;
        bestY = c.pos.y;
      }
    }
    return bestY;
  }

  /** First selected wire id, if any — bend-point drag still targets one wire. */
  get selectedWireId(): string | null {
    return this.selectedWireIds.values().next().value ?? null;
  }
  set selectedWireId(id: string | null) {
    this.selectedWireIds.clear();
    if (id) this.selectedWireIds.add(id);
  }

  constructor(circuit: Circuit, readonly library: ChipLibrary) {
    this.circuit = circuit;
  }

  private noteEdit(): void {
    this.onBeforeEdit?.();
  }

  handleMouseMove(p: Point): void {
    this.hoveredComponentId = findComponentNear(this.circuit, p)?.id ?? null;
    // Wire tool: larger magnet radius so pins are easier to hit while routing.
    const pinRadius = this.tool.kind === 'wire' ? 22 : 10;
    this.hoveredPinId = findPinNear(this.circuit, p, pinRadius)?.id ?? null;
    this.hoveredWireId = (findWaypointNear(this.circuit, p)?.wireId ?? findWireNear(this.circuit, p)?.wireId) ?? null;
    // Snap the rubber-band cursor to a nearby pin while routing.
    if (this.tool.kind === 'wire' && this.hoveredPinId) {
      const pin = this.circuit.allPins().find((x) => x.id === this.hoveredPinId);
      this.mouse = pin ? { ...pin.pos } : p;
    } else {
      this.mouse = p;
    }
  }

  handleMouseDown(p: Point, opts?: { altKey?: boolean; shiftKey?: boolean }): void {
    if (this.tool.kind !== 'select') return;
    this.dragCheckpointTaken = false;

    // Chip pin → Alt/Shift+drag across center to flip side (before body hit-test).
    // Without a modifier, pin near-hits fall through to normal component drag.
    const pinSideModifier = !!(opts?.altKey || opts?.shiftKey);
    if (pinSideModifier) {
      const nearPin = findPinNear(this.circuit, p, 12);
      if (nearPin) {
        const host = this.circuit.components.get(nearPin.componentId);
        if (host?.kind === 'chip') {
          this.pinSideDrag = { componentId: host.id, pinName: nearPin.name, startX: p.x };
          this.selectedIds = new Set([host.id]);
          this.selectedWireId = null;
          return;
        }
      }
    }

    const hit = findComponentNear(this.circuit, p);
    if (hit) {
      // Dragging an already-multi-selected component moves the whole
      // selection together; dragging anything else is just that one part
      // (final selection is resolved on mouseup — see performClick — for
      // the "plain click, no drag" case; a real drag always moves the set
      // computed right here, decided before the gesture can change it).
      const ids = this.selectedIds.has(hit.id) && this.selectedIds.size > 1 ? [...this.selectedIds] : [hit.id];
      this.pendingComponentDrag = { ids, downPoint: p };
      return;
    }

    const wp = findWaypointNear(this.circuit, p);
    if (wp) {
      this.dragWaypoint = wp;
      this.selectedWireId = wp.wireId;
      this.selectedIds.clear();
      return;
    }

    const wireHit = findWireNear(this.circuit, p);
    if (wireHit) {
      this.pendingWireGrab = { ...wireHit, downPoint: p };
      this.selectedWireId = wireHit.wireId;
      this.selectedIds.clear();
      this.highlightNetOfWire(wireHit.wireId);
      return;
    }

    this.marqueeStart = p;
    this.dragging = false;
    this.highlightedNetId = null;
  }

  handleMouseDrag(p: Point): void {
    if (this.pendingComponentDrag) {
      const { ids, downPoint } = this.pendingComponentDrag;
      if (Math.hypot(p.x - downPoint.x, p.y - downPoint.y) > DRAG_THRESHOLD) {
        if (!this.dragCheckpointTaken) {
          this.noteEdit();
          this.dragCheckpointTaken = true;
        }
        this.draggingComponents = { ids, lastPoint: downPoint };
        this.pendingComponentDrag = null;
        this.dragging = true;
        // fall through so this same move is applied immediately below
      } else {
        return;
      }
    }
    if (this.draggingComponents) {
      const dx = p.x - this.draggingComponents.lastPoint.x;
      const dy = p.y - this.draggingComponents.lastPoint.y;
      for (const id of this.draggingComponents.ids) this.circuit.moveComponent(id, dx, dy);
      this.pushWiresWithDrag(this.draggingComponents.ids, dx, dy);
      this.draggingComponents.lastPoint = p;
      this.dragging = true;
      return;
    }
    if (this.pendingWireGrab) {
      const { wireId, insertIndex, downPoint } = this.pendingWireGrab;
      if (Math.hypot(p.x - downPoint.x, p.y - downPoint.y) > DRAG_THRESHOLD) {
        if (!this.dragCheckpointTaken) {
          this.noteEdit();
          this.dragCheckpointTaken = true;
        }
        const wire = this.circuit.wires.get(wireId);
        if (wire) {
          const waypoints = wire.waypoints ? [...wire.waypoints] : [];
          waypoints.splice(insertIndex, 0, this.getSnap(p));
          wire.waypoints = waypoints;
        }
        this.dragWaypoint = { wireId, index: insertIndex };
        this.pendingWireGrab = null;
        this.dragging = true;
      }
      return;
    }
    if (this.dragWaypoint) {
      if (!this.dragCheckpointTaken) {
        this.noteEdit();
        this.dragCheckpointTaken = true;
      }
      const wire = this.circuit.wires.get(this.dragWaypoint.wireId);
      if (wire?.waypoints) wire.waypoints[this.dragWaypoint.index] = this.getSnap(p);
      this.dragging = true;
      return;
    }
    if (!this.marqueeStart) return;
    if (Math.hypot(p.x - this.marqueeStart.x, p.y - this.marqueeStart.y) > DRAG_THRESHOLD) this.dragging = true;
    this.mouse = p;
  }

  /**
   * The one entry point main.ts calls on every mouseup: finalizes whatever
   * drag was in progress (marquee select, or moving/inserting a wire bend
   * point), and — only if nothing was actually dragged this gesture —
   * dispatches a plain click instead. This is what lets grabbing a wire
   * segment either kink it (drag past the threshold) or just select it
   * (release without moving) using the same mousedown.
   */
  handleMouseUp(p: Point, additive: boolean): void {
    let didDrag = false;

    if (this.pinSideDrag) {
      const { componentId, pinName, startX } = this.pinSideDrag;
      this.pinSideDrag = null;
      const chip = this.circuit.components.get(componentId);
      if (chip?.kind === 'chip' && Math.abs(p.x - startX) > DRAG_THRESHOLD) {
        const side: -1 | 1 = p.x < chip.pos.x ? -1 : 1;
        if (this.setChipPinSide(componentId, pinName, side)) didDrag = true;
      }
    }

    if (this.draggingComponents) {
      // Snap every dragged component's final position to the grid — the
      // same finishing touch placement already gets, so a dragged part
      // lines up with everything placed by clicking instead of dragging.
      for (const id of this.draggingComponents.ids) {
        const c = this.circuit.components.get(id);
        if (!c) continue;
        let target = this.getSnap(c.pos);
        if (c.kind === 'source') {
          target = { x: target.x, y: this.magnetSourceRailY(c.value, target.y, c.id) };
        }
        const dx = target.x - c.pos.x;
        const dy = target.y - c.pos.y;
        if (dx !== 0 || dy !== 0) {
          this.circuit.moveComponent(id, dx, dy);
          this.pushWiresWithDrag([id], dx, dy);
        }
      }
      this.selectedIds = new Set(this.draggingComponents.ids);
      this.selectedWireId = null;
      this.draggingComponents = null;
      didDrag = true;
      this.tidySelectedWires(false);
    }
    this.pendingComponentDrag = null; // never promoted past the threshold — a plain click, see performClick

    if (this.dragWaypoint) {
      const wire = this.circuit.wires.get(this.dragWaypoint.wireId);
      if (wire?.waypoints) wire.waypoints[this.dragWaypoint.index] = this.getSnap(p);
      this.dragWaypoint = null;
      didDrag = true;
    }
    this.pendingWireGrab = null; // never promoted past the threshold — a plain click, nothing to commit

    if (this.tool.kind === 'select' && this.marqueeStart && this.dragging) {
      const x0 = Math.min(this.marqueeStart.x, p.x);
      const x1 = Math.max(this.marqueeStart.x, p.x);
      const y0 = Math.min(this.marqueeStart.y, p.y);
      const y1 = Math.max(this.marqueeStart.y, p.y);
      if (!additive) {
        this.selectedIds.clear();
        this.selectedWireIds.clear();
      }
      for (const c of this.circuit.components.values()) {
        if (c.pos.x >= x0 && c.pos.x <= x1 && c.pos.y >= y0 && c.pos.y <= y1) {
          this.selectedIds.add(c.id);
        }
      }
      for (const w of this.circuit.wires.values()) {
        const poly = wirePolyline(this.circuit, w);
        if (!poly) continue;
        if (poly.some((pt) => pt.x >= x0 && pt.x <= x1 && pt.y >= y0 && pt.y <= y1)) {
          this.selectedWireIds.add(w.id);
        }
      }
      didDrag = true;
    }
    this.marqueeStart = null;
    this.dragging = false;

    if (!didDrag) this.performClick(p, additive);
  }

  /**
   * Double-click: the component under the cursor, for main.ts to act on —
   * dive in for a `chip`, prompt a rename for a `label`/`port` (matches the
   * reference project's "double-click to dive in" / "double-click to
   * rename" — same gesture, disambiguated by what was actually hit, since
   * chips and labels/ports never overlap). Double-clicking an existing
   * wire bend point instead removes just that point (straightening the
   * wire there) — handled entirely here, nothing for main.ts to do.
   */
  handleDoubleClick(p: Point): Component | null {
    const hit = findComponentNear(this.circuit, p);
    if (hit) return hit;
    const wp = findWaypointNear(this.circuit, p);
    if (wp) {
      this.noteEdit();
      const wire = this.circuit.wires.get(wp.wireId);
      if (wire?.waypoints) {
        wire.waypoints.splice(wp.index, 1);
        if (wire.waypoints.length === 0) delete wire.waypoints;
      }
    }
    return null;
  }

  handleDelete(): void {
    if (this.selectedWireIds.size === 0 && this.selectedIds.size === 0) return;
    this.noteEdit();
    if (this.selectedWireIds.size > 0) {
      for (const id of this.selectedWireIds) this.circuit.removeWire(id);
      this.selectedWireIds.clear();
      return;
    }
    const removed = [...this.selectedIds];
    for (const id of removed) {
      const c = this.circuit.components.get(id);
      if (c?.kind === 'junction') this.removeJunctionKeepThrough(id);
      else this.circuit.removeComponent(id);
    }
    this.selectedIds.clear();
    if (removed.length > 0) this.onComponentsRemoved?.(removed);
  }

  /**
   * Delete a solder-dot without nuking the wire it sits on: heal the best
   * through-path (two stubs → one wire), drop only the leftover branch stubs
   * that would otherwise dangle without the junction pin.
   */
  removeJunctionKeepThrough(junctionId: string): boolean {
    const j = this.circuit.components.get(junctionId);
    if (!j || j.kind !== 'junction') return false;
    const jPin = j.pins.net.id;
    const pinById = new Map<string, Pin>();
    for (const p of this.circuit.allPins()) pinById.set(p.id, p);

    type Stub = { wireId: string; otherId: string; pathToJ: Point[]; bundleId?: string };
    const stubs: Stub[] = [];
    for (const w of this.circuit.wires.values()) {
      if (w.a !== jPin && w.b !== jPin) continue;
      const otherId = w.a === jPin ? w.b : w.a;
      const other = pinById.get(otherId);
      const jp = pinById.get(jPin);
      if (!other || !jp) continue;
      // Path other → … → junction (for merging).
      let pathToJ: Point[];
      if (w.b === jPin) {
        pathToJ = [other.pos, ...(w.waypoints ?? []).map((q) => ({ x: q.x, y: q.y })), jp.pos];
      } else {
        const wps = w.waypoints ? [...w.waypoints].reverse() : [];
        pathToJ = [other.pos, ...wps.map((q) => ({ x: q.x, y: q.y })), jp.pos];
      }
      stubs.push({ wireId: w.id, otherId, pathToJ, bundleId: w.bundleId });
    }

    for (const s of stubs) this.circuit.removeWire(s.wireId);

    if (stubs.length >= 2) {
      // Prefer a near-collinear pair through the junction (the “wire it sits on”).
      let bestI = 0;
      let bestK = 1;
      let bestScore = -Infinity;
      const jpos = j.pos;
      for (let i = 0; i < stubs.length; i++) {
        for (let k = i + 1; k < stubs.length; k++) {
          const a = stubs[i]!.pathToJ[0]!;
          const b = stubs[k]!.pathToJ[0]!;
          const vax = a.x - jpos.x;
          const vay = a.y - jpos.y;
          const vbx = b.x - jpos.x;
          const vby = b.y - jpos.y;
          const la = Math.hypot(vax, vay) || 1;
          const lb = Math.hypot(vbx, vby) || 1;
          // Collinear opposite directions → dot ≈ -1 (best through-wire).
          const score = -((vax / la) * (vbx / lb) + (vay / la) * (vby / lb));
          if (score > bestScore) {
            bestScore = score;
            bestI = i;
            bestK = k;
          }
        }
      }
      const left = stubs[bestI]!;
      const right = stubs[bestK]!;
      const combined = [...left.pathToJ, ...[...right.pathToJ].reverse().slice(1)];
      const mid = interiorWaypoints(combined);
      const bundleId = left.bundleId || right.bundleId;
      this.circuit.addWire(left.otherId, right.otherId, mid.length ? mid : undefined, bundleId);
      // Other stubs were branches — already removed; they stay gone.
    }

    // No wires left on the junction pin; removeComponent only drops the node.
    this.circuit.removeComponent(junctionId);
    return true;
  }

  /** Copy selected components + wires wholly inside the selection. */
  copySelection(): boolean {
    if (this.selectedIds.size === 0) return false;
    const tmp = new Circuit();
    for (const id of this.selectedIds) {
      const c = this.circuit.components.get(id);
      if (c) tmp.addRawComponent(structuredClone(c) as Component);
    }
    for (const w of this.circuit.wires.values()) {
      const aComp = w.a.split(':')[0]!;
      const bComp = w.b.split(':')[0]!;
      if (this.selectedIds.has(aComp) && this.selectedIds.has(bComp)) {
        tmp.addRawWire(
          w.waypoints
            ? { id: w.id, a: w.a, b: w.b, waypoints: w.waypoints.map((p) => ({ ...p })) }
            : { id: w.id, a: w.a, b: w.b },
        );
      }
    }
    this.clipboard = captureCircuit(tmp);
    return true;
  }

  /** Paste clipboard offset by one grid step; selects the new components. */
  pasteClipboard(): boolean {
    if (!this.clipboard || this.clipboard.components.length === 0) return false;
    this.noteEdit();
    return this.pasteSnapshot(this.clipboard, GRID * 2, GRID * 2);
  }

  /**
   * Duplicate the selection in place (offset by two grid steps) without
   * disturbing the clipboard — Ctrl+D.
   */
  duplicateSelection(): boolean {
    if (this.selectedIds.size === 0) return false;
    const saved = this.clipboard;
    if (!this.copySelection()) return false;
    const snap = this.clipboard;
    this.clipboard = saved;
    if (!snap) return false;
    this.noteEdit();
    return this.pasteSnapshot(snap, GRID * 2, GRID * 2);
  }

  /**
   * Paste `count` copies of the current selection (or clipboard if empty
   * selection after copy) on a grid with pitch (dx, dy) from the original.
   * Relative offsets inside the footprint are preserved.
   */
  stampSelection(count: number, dx: number, dy: number): boolean {
    const n = Math.floor(count);
    if (n < 1) return false;
    let snap: CircuitSnapshot | null = null;
    const saved = this.clipboard;
    if (this.selectedIds.size > 0) {
      if (!this.copySelection()) return false;
      snap = this.clipboard;
      this.clipboard = saved;
    } else {
      snap = this.clipboard;
    }
    if (!snap || snap.components.length === 0) return false;
    this.noteEdit();
    let ok = false;
    for (let i = 1; i <= n; i++) {
      if (this.pasteSnapshot(snap, dx * i, dy * i)) ok = true;
    }
    return ok;
  }

  /**
   * Acknowledge ChipDef revision and re-apply pinSide/layout from the def.
   * Does not remove or recreate pins/wires.
   */
  updateChipFromLibrary(componentId: string): boolean {
    const c = this.circuit.components.get(componentId);
    if (!c || c.kind !== 'chip' || !this.library.has(c.defId)) return false;
    this.noteEdit();
    const def = this.library.get(c.defId);
    syncPinSidesFromDef(c, def);
    c.defRevision = def.revision ?? 0;
    return true;
  }

  private pasteSnapshot(snap: CircuitSnapshot, dx: number, dy: number): boolean {
    if (snap.components.length === 0) return false;
    const idMap = new Map<string, string>();
    const pinMap = new Map<string, string>();
    const newIds: string[] = [];

    for (const sc of snap.components) {
      if (sc.kind === 'chip' && !this.library.has((sc as ChipInstanceComponent).defId)) {
        // Clipboard from a prior project load — def was wiped with the library.
        continue;
      }
      const raw = structuredClone(sc) as Component;
      const prefix =
        raw.kind === 'transistor'
          ? 't'
          : raw.kind === 'source'
            ? 'src'
            : raw.kind === 'chip'
              ? 'chip'
              : raw.kind.slice(0, 3);
      const newId = nextId(prefix);
      idMap.set(raw.id, newId);
      newIds.push(newId);
      raw.id = newId;
      raw.pos = { x: raw.pos.x + dx, y: raw.pos.y + dy };
      for (const p of Object.values(raw.pins) as Pin[]) {
        const oldPinId = p.id;
        const pinName = oldPinId.includes(':') ? oldPinId.slice(oldPinId.indexOf(':') + 1) : p.name;
        p.id = `${newId}:${pinName}`;
        p.componentId = newId;
        p.pos = { x: p.pos.x + dx, y: p.pos.y + dy };
        pinMap.set(oldPinId, p.id);
      }
      if (raw.kind === 'ram' || raw.kind === 'rom') {
        raw.bytes = Uint8Array.from(raw.bytes);
      }
      this.circuit.addComponent(raw);
    }

    for (const w of snap.wires) {
      const a = pinMap.get(w.a);
      const b = pinMap.get(w.b);
      if (!a || !b) continue;
      this.circuit.addWire(
        a,
        b,
        w.waypoints?.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      );
    }

    this.selectedIds = new Set(newIds);
    this.selectedWireId = null;
    return true;
  }

  /** Clears every kind of selection at once (components and selected wires) — e.g. after clearing the circuit or navigating levels. */
  /** Drop clipboard (e.g. after project load — chip defIds may no longer exist). */
  clearClipboard(): void {
    this.clipboard = null;
  }

  clearSelection(): void {
    this.selectedIds.clear();
    this.selectedWireIds.clear();
    this.highlightedNetId = null;
  }

  /**
   * Escape while routing: drop the last bend point, or abandon the wire if
   * there are none left (KiCad-style).
   */
  escapeWireStep(): boolean {
    if (!this.wireStartPinId) return false;
    if (this.wireWaypoints.length > 0) {
      this.wireWaypoints.pop();
      return true;
    }
    this.cancelWire();
    return true;
  }

  /** Highlight the electrical net of a wire (same net labels / pin connectivity). */
  highlightNetOfWire(wireId: string): void {
    const w = this.circuit.wires.get(wireId);
    if (!w) {
      this.highlightedNetId = null;
      return;
    }
    const nets = this.circuit.computeNets();
    this.highlightedNetId = nets.netOf.get(w.a) ?? null;
  }

  /** Net id under the pointer (hovered wire or pin), else the sticky H highlight. */
  netIdUnderPointer(): string | null {
    const nets = this.circuit.computeNets();
    if (this.hoveredPinId) {
      return nets.netOf.get(this.hoveredPinId) ?? null;
    }
    if (this.hoveredWireId) {
      const w = this.circuit.wires.get(this.hoveredWireId);
      if (w) return nets.netOf.get(w.a) ?? null;
    }
    return this.highlightedNetId;
  }

  /** Human-readable net name for UI (label name, or short anonymous id). */
  formatNetName(netId: string | null): string | null {
    if (!netId) return null;
    if (!netId.includes(':')) return netId; // named label net (VCC, GND, foo)
    const short = netId.length > 18 ? netId.slice(0, 16) + '…' : netId;
    return short;
  }

  /** Highlight the net of the first pin on a selected component (H key). */
  highlightSelectionNet(): void {
    if (this.selectedWireIds.size > 0) {
      const first = this.selectedWireIds.values().next().value!;
      this.highlightNetOfWire(first);
      return;
    }
    const id = [...this.selectedIds][0];
    if (!id) {
      this.highlightedNetId = null;
      return;
    }
    const c = this.circuit.components.get(id);
    if (!c) return;
    const pin = Object.values(c.pins)[0] as Pin | undefined;
    if (!pin) return;
    const nets = this.circuit.computeNets();
    this.highlightedNetId = nets.netOf.get(pin.id) ?? null;
  }

  /**
   * Align selected component centers. `axis` is the coordinate to equalize;
   * `edge` picks min / max / mid of the selection.
   */
  alignSelection(axis: 'x' | 'y', edge: 'min' | 'max' | 'mid'): number {
    const comps = [...this.selectedIds]
      .map((id) => this.circuit.components.get(id))
      .filter((c): c is Component => !!c);
    if (comps.length < 2) return 0;
    const vals = comps.map((c) => c.pos[axis]);
    const target =
      edge === 'min' ? Math.min(...vals) : edge === 'max' ? Math.max(...vals) : (Math.min(...vals) + Math.max(...vals)) / 2;
    const snapped = Math.round(target / GRID) * GRID;
    this.noteEdit();
    for (const c of comps) {
      const delta = snapped - c.pos[axis];
      if (delta === 0) continue;
      if (axis === 'x') this.circuit.moveComponent(c.id, delta, 0);
      else this.circuit.moveComponent(c.id, 0, delta);
    }
    return comps.length;
  }

  /** Evenly space selected components between the leftmost/topmost and rightmost/bottommost. */
  distributeSelection(axis: 'x' | 'y'): number {
    const comps = [...this.selectedIds]
      .map((id) => this.circuit.components.get(id))
      .filter((c): c is Component => !!c);
    if (comps.length < 3) return 0;
    comps.sort((a, b) => a.pos[axis] - b.pos[axis]);
    const first = comps[0]!.pos[axis];
    const last = comps[comps.length - 1]!.pos[axis];
    if (Math.abs(last - first) < 1) return 0;
    this.noteEdit();
    for (let i = 1; i < comps.length - 1; i++) {
      const ideal = first + ((last - first) * i) / (comps.length - 1);
      const snapped = Math.round(ideal / GRID) * GRID;
      const c = comps[i]!;
      const delta = snapped - c.pos[axis];
      if (delta === 0) continue;
      if (axis === 'x') this.circuit.moveComponent(c.id, delta, 0);
      else this.circuit.moveComponent(c.id, 0, delta);
    }
    return comps.length;
  }

  /**
   * While dragging components: translate waypoints of wires whose both ends
   * are selected; for wires with one end in the selection, shift only the
   * elbow nearest that pin. Full tidy still runs on mouseup.
   */
  pushWiresWithDrag(ids: string[], dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    const sel = new Set(ids);
    const pinById = new Map<string, Pin>();
    for (const p of this.circuit.allPins()) pinById.set(p.id, p);

    for (const w of this.circuit.wires.values()) {
      const aComp = w.a.split(':')[0]!;
      const bComp = w.b.split(':')[0]!;
      const aSel = sel.has(aComp);
      const bSel = sel.has(bComp);
      if (!aSel && !bSel) continue;

      if (aSel && bSel) {
        if (!w.waypoints?.length) continue;
        for (const wp of w.waypoints) {
          wp.x += dx;
          wp.y += dy;
        }
        continue;
      }

      if (!w.waypoints?.length) continue;
      const pin = pinById.get(aSel ? w.a : w.b);
      if (!pin) continue;
      let bestI = 0;
      let bestD = Infinity;
      for (let i = 0; i < w.waypoints.length; i++) {
        const d = dist(w.waypoints[i]!, pin.pos);
        if (d < bestD) {
          bestD = d;
          bestI = i;
        }
      }
      const elbow = w.waypoints[bestI]!;
      elbow.x += dx;
      elbow.y += dy;
    }
  }

  /**
   * Re-route every wire with smart ortho + pin-exit stubs (examples / tutorials).
   */
  tidyAllWires(checkpoint = true): number {
    const prevSel = new Set(this.selectedWireIds);
    const prevComp = new Set(this.selectedIds);
    this.selectedWireIds = new Set(this.circuit.wires.keys());
    this.selectedIds.clear();
    const n = this.tidySelectedWires(checkpoint);
    this.selectedWireIds = prevSel;
    this.selectedIds = prevComp;
    return n;
  }

  /**
   * Re-route selected wires (or wires attached to selected components) with
   * fresh orthogonal waypoints — drops manual kinks. Avoids chip/RAM/ROM/button bodies.
   */
  tidySelectedWires(checkpoint = true): number {
    const pinById = new Map<string, Pin>();
    for (const p of this.circuit.allPins()) pinById.set(p.id, p);

    const wireIds = new Set<string>();
    if (this.selectedWireIds.size > 0) {
      for (const id of this.selectedWireIds) wireIds.add(id);
    }
    if (this.selectedIds.size > 0) {
      for (const w of this.circuit.wires.values()) {
        const aComp = w.a.split(':')[0];
        const bComp = w.b.split(':')[0];
        if (this.selectedIds.has(aComp!) || this.selectedIds.has(bComp!)) wireIds.add(w.id);
      }
    }
    if (wireIds.size === 0) return 0;

    if (checkpoint) this.noteEdit();
    const nets = this.circuit.computeNets();
    // Other wires' drawn paths — penalize crossings; same-net rewarded via preferAlong.
    const otherPaths: Point[][] = [];
    const pathByWireId = new Map<string, Point[]>();
    for (const ow of this.circuit.wires.values()) {
      const poly = rawWirePolyline(this.circuit, ow);
      if (!poly) continue;
      const drawn = routeWirePoints(poly);
      pathByWireId.set(ow.id, drawn);
      if (!wireIds.has(ow.id)) otherPaths.push(drawn);
    }
    let n = 0;
    for (const id of wireIds) {
      const w = this.circuit.wires.get(id);
      if (!w) continue;
      const a = pinById.get(w.a);
      const b = pinById.get(w.b);
      if (!a || !b) continue;
      const aComp = this.circuit.components.get(a.componentId);
      const bComp = this.circuit.components.get(b.componentId);
      const exclude = new Set([a.componentId, b.componentId]);
      const netId = nets.netOf.get(w.a);
      const preferAlong: Point[][] = [];
      if (netId) {
        for (const ow of this.circuit.wires.values()) {
          if (ow.id === id) continue;
          if (nets.netOf.get(ow.a) !== netId) continue;
          const drawn = pathByWireId.get(ow.id);
          if (drawn) preferAlong.push(drawn);
        }
      }
      const routed = routeWirePoints([a.pos, b.pos], {
        obstacles: routingObstacles(this.circuit, exclude),
        startDir: aComp ? pinExitDir(a.pos, aComp.pos) : null,
        endDir: bComp ? pinExitDir(b.pos, bComp.pos) : null,
        avoidCrossings: otherPaths,
        preferAlong,
      });
      // Store interior elbows only; drawing re-expands via routeWirePoints.
      const mid = routed.slice(1, -1).map((p) => ({ x: p.x, y: p.y }));
      if (mid.length > 0) w.waypoints = mid;
      else delete w.waypoints;
      n++;
    }
    return n;
  }

  /**
   * Flip a chip pin between left/right stacks (pinSide). Returns true if changed.
   */
  setChipPinSide(componentId: string, pinName: string, side: -1 | 1): boolean {
    const c = this.circuit.components.get(componentId);
    if (!c || c.kind !== 'chip') return false;
    if (!c.pinSide) c.pinSide = {};
    if (c.pinSide[pinName] === side) return false;
    this.noteEdit();
    c.pinSide[pinName] = side;
    applyPinLayout(c);
    this.tidySelectedWires(false);
    return true;
  }

  /** Grow an analyzer by one channel; returns the new pin id or null. */
  addAnalyzerChannel(analyzerId: string): string | null {
    const c = this.circuit.components.get(analyzerId);
    if (!c || c.kind !== 'analyzer') return null;
    this.noteEdit();
    const i = c.channelCount;
    c.channelCount = i + 1;
    const name = `ch${i}`;
    c.pins[name] = {
      id: `${c.id}:${name}`,
      componentId: c.id,
      name,
      pos: { ...c.pos },
    };
    if (!c.pinOrder.includes(name)) c.pinOrder.push(name);
    if (!c.channelLabels) c.channelLabels = [];
    while (c.channelLabels.length < c.channelCount) c.channelLabels.push(`ch${c.channelLabels.length}`);
    applyPinLayout(c);
    return c.pins[name]!.id;
  }

  /** Drop the highest channel (keeps at least one); returns true if changed. */
  removeAnalyzerChannel(analyzerId: string): boolean {
    const c = this.circuit.components.get(analyzerId);
    if (!c || c.kind !== 'analyzer' || c.channelCount <= 1) return false;
    this.noteEdit();
    const i = c.channelCount - 1;
    const name = `ch${i}`;
    const pin = c.pins[name];
    const removedId = pin?.id;
    delete c.pins[name];
    c.pinOrder = c.pinOrder.filter((p) => p !== name);
    c.channelCount = i;
    if (c.channelLabels) c.channelLabels = c.channelLabels.slice(0, i);
    if (c.triggerChannel != null && c.triggerChannel >= i) c.triggerChannel = null;
    applyPinLayout(c);
    if (removedId) {
      for (const [wid, w] of [...this.circuit.wires]) {
        if (w.a === removedId || w.b === removedId) this.circuit.removeWire(wid);
      }
    }
    return true;
  }

  /** Enable / disable decimal-point pin on a 7-seg display. */
  setSevenSegHasDp(id: string, hasDp: boolean): boolean {
    const c = this.circuit.components.get(id);
    if (!c || c.kind !== 'sevenseg' || c.hasDp === hasDp) return false;
    this.noteEdit();
    c.hasDp = hasDp;
    if (hasDp) {
      if (!c.pins.dp) {
        c.pins.dp = { id: `${c.id}:dp`, componentId: c.id, name: 'dp', pos: { ...c.pos } };
      }
      if (!c.pinOrder.includes('dp')) c.pinOrder.push('dp');
    } else {
      const dp = c.pins.dp;
      delete c.pins.dp;
      c.pinOrder = c.pinOrder.filter((p) => p !== 'dp');
      if (dp) {
        for (const [wid, w] of [...this.circuit.wires]) {
          if (w.a === dp.id || w.b === dp.id) this.circuit.removeWire(wid);
        }
      }
    }
    applyPinLayout(c);
    return true;
  }

  /** Change bus-probe width (1–32); drops wires on removed high bits. */
  setBusProbeWidth(busId: string, bitWidth: number): boolean {
    const c = this.circuit.components.get(busId);
    if (!c || c.kind !== 'busprobe') return false;
    const n = Math.max(1, Math.min(32, bitWidth | 0));
    if (n === c.bitWidth) return false;
    this.noteEdit();
    const removed: string[] = [];
    for (let i = n; i < c.bitWidth; i++) {
      const p = c.pins[`b${i}`];
      if (p) removed.push(p.id);
    }
    c.bitWidth = n;
    relayoutBusProbePins(c);
    applyPinLayout(c);
    if (removed.length) {
      for (const [wid, w] of [...this.circuit.wires]) {
        if (removed.includes(w.a) || removed.includes(w.b)) this.circuit.removeWire(wid);
      }
    }
    return true;
  }

  setBusProbeRadix(busId: string, radix: 'hex' | 'dec' | 'bin'): boolean {
    const c = this.circuit.components.get(busId);
    if (!c || c.kind !== 'busprobe') return false;
    if (c.radix === radix) return false;
    this.noteEdit();
    c.radix = radix;
    return true;
  }

  /** Change bus-switch width (1–32); drops wires on removed high bits. */
  setBusSwitchWidth(id: string, bitWidth: number): boolean {
    const c = this.circuit.components.get(id);
    if (!c || c.kind !== 'busswitch') return false;
    const n = Math.max(1, Math.min(32, bitWidth | 0));
    if (n === c.bitWidth) return false;
    this.noteEdit();
    const removed: string[] = [];
    for (let i = n; i < c.bitWidth; i++) {
      const p = c.pins[`b${i}`];
      if (p) removed.push(p.id);
    }
    c.bitWidth = n;
    relayoutBusSwitchPins(c);
    applyPinLayout(c);
    if (removed.length) {
      for (const [wid, w] of [...this.circuit.wires]) {
        if (removed.includes(w.a) || removed.includes(w.b)) this.circuit.removeWire(wid);
      }
    }
    return true;
  }

  setBusSwitchRadix(id: string, radix: 'hex' | 'dec' | 'bin'): boolean {
    const c = this.circuit.components.get(id);
    if (!c || c.kind !== 'busswitch') return false;
    if (c.radix === radix) return false;
    this.noteEdit();
    c.radix = radix;
    return true;
  }

  setBusSwitchValue(id: string, value: number): boolean {
    const c = this.circuit.components.get(id);
    if (!c || c.kind !== 'busswitch') return false;
    const mask = c.bitWidth >= 31 ? 0x7fffffff : (1 << c.bitWidth) - 1;
    const v = (value | 0) & mask;
    if (v === c.value) return false;
    this.noteEdit();
    c.value = v;
    return true;
  }

  /** Optional custom chip body width / silkscreen marking. */
  setChipAppearance(componentId: string, opts: { boxWidth?: number; marking?: string }): boolean {
    const c = this.circuit.components.get(componentId);
    if (!c || c.kind !== 'chip') return false;
    this.noteEdit();
    if (opts.boxWidth != null) {
      c.boxWidth = Math.max(48, Math.min(240, Math.round(opts.boxWidth / GRID) * GRID));
    }
    if (opts.marking != null) {
      const m = opts.marking.trim();
      if (m) c.marking = m;
      else delete c.marking;
    }
    applyPinLayout(c);
    return true;
  }

  /** Abandon the wire currently being drawn, if any. Called on tool switch, Escape, or level navigation. */
  cancelWire(): void {
    this.wireStartPinId = null;
    this.wireWaypoints = [];
  }

  private performClick(p: Point, additive: boolean): void {
    if (this.tool.kind === 'wire') {
      this.handleWireClick(p);
      return;
    }
    if (this.tool.kind === 'select') {
      const hit = findComponentNear(this.circuit, p);
      if (hit) {
        this.selectedWireId = null;
        if (hit.kind === 'input') hit.value = hit.value === 1 ? 0 : 1;
        if (hit.kind === 'busswitch' && !additive) {
          // DIP paddles toggle one bit; click on the readout steps the whole value.
          // (Hex step-by-0x10 used to no-op on 4-bit switches: (v+16)&0xF === v.)
          const bit = busSwitchBitAt(hit, p);
          if (bit != null) {
            hit.value ^= 1 << bit;
          } else {
            const mask = hit.bitWidth >= 31 ? 0x7fffffff : (1 << hit.bitWidth) - 1;
            hit.value = (hit.value + 1) & mask;
          }
        }
        if (hit.kind === 'button') {
          if (hit.mode === 'toggle') {
            hit.value = hit.value === 1 ? 0 : 1;
          } else {
            hit.value = 1;
            hit.holdFrames = Math.max(1, hit.pulseFrames);
          }
        }
        if (hit.kind === 'clock') {
          firePulse(hit);
        }
        if (additive) {
          if (this.selectedIds.has(hit.id)) this.selectedIds.delete(hit.id);
          else this.selectedIds.add(hit.id);
        } else {
          this.selectedIds = new Set([hit.id]);
        }
        return;
      }
      const wireId = findWaypointNear(this.circuit, p)?.wireId ?? findWireNear(this.circuit, p)?.wireId;
      if (wireId) {
        this.selectedIds.clear();
        this.selectedWireId = wireId;
        return;
      }
      if (!additive) this.clearSelection();
      return;
    }
    if (this.tool.kind === 'pan') return; // panning is handled entirely by main.ts on drag
    this.placeAt(this.getSnap(p));
  }

  /**
   * Click-to-route wiring: first click on a pin (or wire node / mid-wire T-junction)
   * starts the wire; further empty clicks add bends; click a pin or another wire
   * commits. Pin→pin with no manual bends uses smart orthogonal routing (obstacles /
   * crossings) like Tidy — same as Turing Complete nodes + our auto-route.
   */
  private handleWireClick(p: Point): void {
    const pin = findPinNear(this.circuit, p, 22);
    if (!this.wireStartPinId) {
      if (pin) {
        this.wireStartPinId = pin.id;
        return;
      }
      // Click existing bend → promote to junction and start a branch.
      const wp = findWaypointNear(this.circuit, p, 10);
      if (wp) {
        this.noteEdit();
        const jPin = this.splitWireAtWaypoint(wp.wireId, wp.index);
        if (jPin) this.wireStartPinId = jPin.id;
        return;
      }
      // Click mid-wire → solder-dot + start branch (TC-style node).
      const seg = findWireNear(this.circuit, p, 8);
      if (seg) {
        this.noteEdit();
        const jPin = this.splitWireAtPoint(seg.wireId, p);
        if (jPin) this.wireStartPinId = jPin.id;
      }
      return;
    }

    if (pin) {
      if (pin.id !== this.wireStartPinId) {
        this.noteEdit();
        this.commitRoutedWire(this.wireStartPinId, pin.id, this.wireWaypoints);
      }
      this.cancelWire();
      return;
    }

    // Drop onto another wire → T-junction finish (unless already same net).
    const seg = findWireNear(this.circuit, p, 8);
    if (seg) {
      const w = this.circuit.wires.get(seg.wireId);
      if (w) {
        const nets = this.circuit.computeNets();
        const startNet = nets.netOf.get(this.wireStartPinId);
        const wireNet = nets.netOf.get(w.a);
        if (startNet && wireNet && startNet === wireNet) {
          this.wireWaypoints.push(this.getSnap(p));
          return;
        }
        this.noteEdit();
        const jPin = this.splitWireAtPoint(seg.wireId, p);
        if (jPin && jPin.id !== this.wireStartPinId) {
          this.commitRoutedWire(this.wireStartPinId, jPin.id, this.wireWaypoints);
        }
        this.cancelWire();
        return;
      }
    }

    this.wireWaypoints.push(this.getSnap(p));
  }

  /**
   * Add a wire with smart ortho routing when the user did not place bends;
   * otherwise keep their waypoints.
   */
  private commitRoutedWire(aId: string, bId: string, manualWaypoints: Point[]): void {
    if (manualWaypoints.length > 0) {
      this.circuit.addWire(aId, bId, manualWaypoints.map((q) => ({ x: q.x, y: q.y })));
      return;
    }
    const pinById = new Map<string, Pin>();
    for (const pin of this.circuit.allPins()) pinById.set(pin.id, pin);
    const a = pinById.get(aId);
    const b = pinById.get(bId);
    if (!a || !b) {
      this.circuit.addWire(aId, bId);
      return;
    }
    const aComp = this.circuit.components.get(a.componentId);
    const bComp = this.circuit.components.get(b.componentId);
    const exclude = new Set([a.componentId, b.componentId]);
    const nets = this.circuit.computeNets();
    const otherPaths: Point[][] = [];
    const preferAlong: Point[][] = [];
    const netId = nets.netOf.get(aId);
    for (const ow of this.circuit.wires.values()) {
      const poly = rawWirePolyline(this.circuit, ow);
      if (!poly) continue;
      const drawn = routeWirePoints(poly);
      otherPaths.push(drawn);
      if (netId && nets.netOf.get(ow.a) === netId) preferAlong.push(drawn);
    }
    const routed = routeWirePoints([a.pos, b.pos], {
      obstacles: routingObstacles(this.circuit, exclude),
      startDir: aComp ? pinExitDir(a.pos, aComp.pos) : null,
      endDir: bComp ? pinExitDir(b.pos, bComp.pos) : null,
      avoidCrossings: otherPaths,
      preferAlong,
    });
    const mid = interiorWaypoints(routed);
    this.circuit.addWire(aId, bId, mid.length ? mid : undefined);
  }

  /** Split wire at a stored waypoint index → junction pin (replaces that bend). */
  private splitWireAtWaypoint(wireId: string, index: number): Pin | null {
    const w = this.circuit.wires.get(wireId);
    if (!w?.waypoints?.[index]) return null;
    const jPos = { ...w.waypoints[index]! };
    const existing = findPinNear(this.circuit, jPos, 4);
    if (existing) {
      const comp = this.circuit.components.get(existing.componentId);
      if (comp?.kind === 'junction') {
        // Already a node — just use it (wire still has the bend; leave topology).
        return existing;
      }
    }
    const j = makeJunction(this.circuit, jPos);
    const left = w.waypoints.slice(0, index);
    const right = w.waypoints.slice(index + 1);
    const bundleId = w.bundleId;
    this.circuit.removeWire(w.id);
    this.circuit.addWire(w.a, j.pins.net.id, left.length ? left : undefined, bundleId);
    this.circuit.addWire(j.pins.net.id, w.b, right.length ? right : undefined, bundleId);
    return j.pins.net;
  }

  /** Split drawn wire path at click → junction; returns junction pin. */
  private splitWireAtPoint(wireId: string, p: Point): Pin | null {
    const w = this.circuit.wires.get(wireId);
    if (!w) return null;
    const drawn = wirePolyline(this.circuit, w);
    if (!drawn || drawn.length < 2) return null;
    const hit = nearestOnPolyline(drawn, p, 12);
    if (!hit) return null;
    const jPos = this.getSnap(hit.point);
    // Too close to an endpoint → start from that pin instead.
    if (dist(jPos, drawn[0]!) < 10) {
      const pinById = new Map(this.circuit.allPins().map((x) => [x.id, x]));
      return pinById.get(w.a) ?? null;
    }
    if (dist(jPos, drawn[drawn.length - 1]!) < 10) {
      const pinById = new Map(this.circuit.allPins().map((x) => [x.id, x]));
      return pinById.get(w.b) ?? null;
    }
    const near = findPinNear(this.circuit, jPos, 6);
    if (near) {
      const comp = this.circuit.components.get(near.componentId);
      if (comp?.kind === 'junction') return near;
    }
    const left = [...drawn.slice(0, hit.segIndex + 1), jPos];
    const right = [jPos, ...drawn.slice(hit.segIndex + 1)];
    const leftMid = interiorWaypoints(left);
    const rightMid = interiorWaypoints(right);
    const j = makeJunction(this.circuit, jPos);
    const bundleId = w.bundleId;
    this.circuit.removeWire(w.id);
    this.circuit.addWire(w.a, j.pins.net.id, leftMid.length ? leftMid : undefined, bundleId);
    this.circuit.addWire(j.pins.net.id, w.b, rightMid.length ? rightMid : undefined, bundleId);
    return j.pins.net;
  }

  private placeAt(p: Point): void {
    const place = (fn: () => void) => {
      this.noteEdit();
      fn();
    };
    switch (this.tool.kind) {
      case 'nmos':
        place(() => makeTransistor(this.circuit, 'N', p));
        break;
      case 'pmos':
        place(() => makeTransistor(this.circuit, 'P', p));
        break;
      case 'vcc': {
        const y = this.magnetSourceRailY(1, p.y);
        place(() => makeSource(this.circuit, 1, { x: p.x, y }));
        break;
      }
      case 'gnd': {
        const y = this.magnetSourceRailY(0, p.y);
        place(() => makeSource(this.circuit, 0, { x: p.x, y }));
        break;
      }
      case 'input':
        place(() => makeInput(this.circuit, 0, p));
        break;
      case 'button':
        place(() => makeButton(this.circuit, p));
        break;
      case 'led':
        place(() => makeLed(this.circuit, p));
        break;
      case 'sevenseg':
        place(() => makeSevenSeg(this.circuit, p));
        break;
      case 'clock':
        place(() => makeClock(this.circuit, p));
        break;
      case 'analyzer': {
        void showPrompt('Analyzer channels (1–64):', '8').then((raw) => {
          if (!raw) return;
          const n = parseInt(raw, 10);
          if (!Number.isFinite(n) || n < 1) return;
          this.noteEdit();
          makeAnalyzer(this.circuit, n, p);
        });
        break;
      }
      case 'busprobe': {
        void showPrompt('Bus probe width (1–32 bits):', '8').then((raw) => {
          if (!raw) return;
          const n = parseInt(raw, 10);
          if (!Number.isFinite(n) || n < 1) return;
          this.noteEdit();
          makeBusProbe(this.circuit, n, p);
        });
        break;
      }
      case 'busswitch': {
        void showPrompt('Bus switch width (4 or 8):', '8').then((raw) => {
          if (!raw) return;
          let n = parseInt(raw, 10);
          if (!Number.isFinite(n) || n < 1) return;
          if (n !== 4 && n !== 8) n = n <= 4 ? 4 : 8;
          this.noteEdit();
          makeBusSwitch(this.circuit, n, p);
        });
        break;
      }
      case 'tty':
        place(() => makeTty(this.circuit, p));
        break;
      case 'probe':
        place(() => makeProbe(this.circuit, p));
        break;
      case 'label': {
        void showPrompt('Net name:', 'net').then((name) => {
          if (name) {
            this.noteEdit();
            makeLabel(this.circuit, name, p);
          }
        });
        break;
      }
      case 'port': {
        if (this.tool.promptName) {
          void showPrompt('Port name or bus (D[7:0]):', 'D[7:0]').then((name) => {
            const trimmed = name?.trim();
            if (!trimmed) return;
            this.noteEdit();
            const bus = parseBusPortSpec(trimmed);
            if (bus) {
              for (let i = 0; i < bus.names.length; i++) {
                makePort(this.circuit, bus.names[i]!, { x: p.x, y: p.y + i * GRID });
              }
            } else {
              makePort(this.circuit, trimmed, p);
            }
          });
        } else {
          place(() => makePort(this.circuit, nextAutoPortName(this.circuit), p));
        }
        break;
      }
      case 'place-chip': {
        if (!this.library.has(this.tool.defId)) {
          // Stale palette selection after Lab course / example reload.
          this.tool = { kind: 'select' };
          break;
        }
        const def = this.library.get(this.tool.defId);
        place(() => makeChipInstance(this.circuit, def, p));
        break;
      }
    }
  }

  /** Components that support multi-bit ribbon wiring by shared pin name. */
  private ribbonTarget(
    c: Component | undefined,
  ): c is Component & {
    kind: 'chip' | 'sevenseg' | 'busprobe' | 'busswitch' | 'analyzer';
    pins: Record<string, Pin>;
  } {
    return (
      !!c &&
      (c.kind === 'chip' ||
        c.kind === 'sevenseg' ||
        c.kind === 'busprobe' ||
        c.kind === 'busswitch' ||
        c.kind === 'analyzer')
    );
  }

  private isBankDriver(c: Component | undefined): c is Component & {
    kind: 'input' | 'button';
    pins: { out: Pin };
    pos: Point;
  } {
    return !!c && (c.kind === 'input' || c.kind === 'button');
  }

  /**
   * True when Wire matching / bus pins can run (2 ribbon targets, chip+bank,
   * or bus-switch + chip).
   */
  canWireMatchingPorts(): boolean {
    if (this.ribbonBusSwitchPair()) return true;
    if (this.ribbonBankPair()) return true;
    const pair = this.ribbonPair();
    if (!pair) return false;
    return matchingPortPairs(pair[0].pins, pair[1].pins).length > 0;
  }

  /** Selection is specifically a bus switch + chip (or hover chip). */
  canRibbonBusSwitch(): boolean {
    return this.ribbonBusSwitchPair() != null;
  }

  /**
   * Bus switch (b0..) + chip/host — one-click ribbon onto a/d/in/data/addr/q.
   */
  private ribbonBusSwitchPair(): {
    sw: Component & { kind: 'busswitch'; pins: Record<string, Pin>; pos: Point };
    host: Component & { pins: Record<string, Pin>; pos: Point };
  } | null {
    const selected = [...this.selectedIds]
      .map((id) => this.circuit.components.get(id))
      .filter((c): c is Component => !!c);
    const switches = selected.filter((c) => c.kind === 'busswitch') as Array<
      Component & { kind: 'busswitch'; pins: Record<string, Pin>; pos: Point }
    >;
    const hosts = selected.filter(
      (c) => c.kind === 'chip' || c.kind === 'busprobe' || c.kind === 'analyzer' || c.kind === 'sevenseg',
    ) as Array<Component & { pins: Record<string, Pin>; pos: Point }>;

    if (switches.length === 1 && hosts.length === 1) {
      return { sw: switches[0]!, host: hosts[0]! };
    }
    if (switches.length === 1 && hosts.length === 0 && this.hoveredPinId) {
      const pin = this.circuit.allPins().find((p) => p.id === this.hoveredPinId);
      const other = pin ? this.circuit.components.get(pin.componentId) : undefined;
      if (
        other &&
        (other.kind === 'chip' ||
          other.kind === 'busprobe' ||
          other.kind === 'analyzer' ||
          other.kind === 'sevenseg') &&
        other.id !== switches[0]!.id
      ) {
        return {
          sw: switches[0]!,
          host: other as Component & { pins: Record<string, Pin>; pos: Point },
        };
      }
    }
    if (hosts.length === 1 && switches.length === 0 && this.hoveredPinId) {
      const pin = this.circuit.allPins().find((p) => p.id === this.hoveredPinId);
      const other = pin ? this.circuit.components.get(pin.componentId) : undefined;
      if (other?.kind === 'busswitch' && other.id !== hosts[0]!.id) {
        return {
          sw: other as Component & { kind: 'busswitch'; pins: Record<string, Pin>; pos: Point },
          host: hosts[0]!,
        };
      }
    }
    return null;
  }

  /**
   * Ribbon bus-switch `bN` onto the best host bus (`a`/`d`/`in`/`data`/`addr`/`q`/`b`).
   * Returns number of new wires.
   */
  wireBusSwitchToHost(checkpoint = true): number {
    const pair = this.ribbonBusSwitchPair();
    if (!pair) return 0;
    const { sw, host } = pair;
    const swBits: string[] = [];
    for (let i = 0; i < 64; i++) {
      if (sw.pins[`b${i}`]) swBits.push(`b${i}`);
      else break;
    }
    if (swBits.length === 0) return 0;

    const prefixes = ['a', 'd', 'in', 'data', 'addr', 'q', 'b', 's', 'ch'] as const;
    let hostNames: string[] | null = null;
    for (const pref of prefixes) {
      const names: string[] = [];
      for (let i = 0; i < 64; i++) {
        const name = `${pref}${i}`;
        if (host.pins[name]) names.push(name);
        else break;
      }
      if (names.length >= 1) {
        hostNames = names;
        break;
      }
    }
    if (!hostNames?.length) return 0;

    if (checkpoint) this.noteEdit();
    let nets = this.circuit.computeNets();
    let n = 0;
    const otherPaths: Point[][] = [];
    for (const ow of this.circuit.wires.values()) {
      const poly = rawWirePolyline(this.circuit, ow);
      if (poly) otherPaths.push(routeWirePoints(poly));
    }
    const bundleId = `bundle-${nextId('rb')}`;
    const count = Math.min(swBits.length, hostNames.length);
    for (let i = 0; i < count; i++) {
      const pa = sw.pins[swBits[i]!]!;
      const pb = host.pins[hostNames[i]!]!;
      const netA = nets.netOf.get(pa.id);
      const netB = nets.netOf.get(pb.id);
      if (netA !== undefined && netB !== undefined && netA === netB) continue;
      const exclude = new Set([sw.id, host.id]);
      const routed = routeWirePoints([pa.pos, pb.pos], {
        obstacles: routingObstacles(this.circuit, exclude),
        startDir: pinExitDir(pa.pos, sw.pos),
        endDir: pinExitDir(pb.pos, host.pos),
        avoidCrossings: otherPaths,
        preferAlong: otherPaths.filter((_, j) => j >= otherPaths.length - n),
      });
      const mid = routed.slice(1, -1).map((p) => ({ x: p.x, y: p.y }));
      this.circuit.addWire(pa.id, pb.id, mid.length ? mid : undefined, bundleId);
      otherPaths.push(routed);
      n++;
      nets = this.circuit.computeNets();
    }
    return n;
  }

  private ribbonPair(): [
    Component & { pins: Record<string, Pin>; pos: Point },
    Component & { pins: Record<string, Pin>; pos: Point },
  ] | null {
    const selected = [...this.selectedIds]
      .map((id) => this.circuit.components.get(id))
      .filter((c): c is Component => this.ribbonTarget(c));
    if (selected.length === 2 && this.ribbonTarget(selected[0]) && this.ribbonTarget(selected[1])) {
      return [selected[0], selected[1]];
    }
    if (selected.length === 1 && this.hoveredPinId) {
      const pin = this.circuit.allPins().find((p) => p.id === this.hoveredPinId);
      const other = pin ? this.circuit.components.get(pin.componentId) : undefined;
      if (this.ribbonTarget(other) && this.ribbonTarget(selected[0]) && other.id !== selected[0].id) {
        return [selected[0], other];
      }
    }
    return null;
  }

  /**
   * Chip (or busprobe/analyzer) + multiple selected inputs/buttons sorted by Y
   * → wire to d0.. / q0.. / b0.. / ch0.. by stamp order.
   */
  private ribbonBankPair(): {
    host: Component & { pins: Record<string, Pin>; pos: Point };
    banks: Array<Component & { pins: { out: Pin }; pos: Point }>;
  } | null {
    const selected = [...this.selectedIds]
      .map((id) => this.circuit.components.get(id))
      .filter((c): c is Component => !!c);
    const hosts = selected.filter((c) => this.ribbonTarget(c));
    const banks = selected.filter((c) => this.isBankDriver(c)) as Array<
      Component & { pins: { out: Pin }; pos: Point }
    >;
    if (hosts.length === 1 && banks.length >= 2) {
      return { host: hosts[0]!, banks };
    }
    // Also: one host selected + hover on bank, with other banks selected
    if (hosts.length === 1 && banks.length >= 1) return { host: hosts[0]!, banks };
    return null;
  }

  /**
   * Wire matching pins between two chips (or chip+sevenseg/busprobe): exact
   * names first, then bus remaps (qN↔dN/bN, aN↔bN, …). Also wires Input/Button
   * banks (sorted by Y) onto d0../q0../b0... Skips already-connected.
   */
  wireMatchingPorts(checkpoint = true): number {
    // Prefer explicit bus-switch → chip ribbon when that pair is selected.
    if (this.ribbonBusSwitchPair()) {
      return this.wireBusSwitchToHost(checkpoint);
    }
    const bank = this.ribbonBankPair();
    if (bank && bank.banks.length >= 1) {
      return this.wireBankToHost(bank.host, bank.banks, checkpoint);
    }

    const pair = this.ribbonPair();
    if (!pair) return 0;
    const [a, b] = pair;
    const pairs = matchingPortPairs(a.pins, b.pins);
    if (pairs.length === 0) return 0;

    if (checkpoint) this.noteEdit();
    let nets = this.circuit.computeNets();
    let n = 0;
    const otherPaths: Point[][] = [];
    for (const ow of this.circuit.wires.values()) {
      const poly = rawWirePolyline(this.circuit, ow);
      if (poly) otherPaths.push(routeWirePoints(poly));
    }

    const bundleId = `bundle-${nextId('rb')}`;
    for (const { na, nb } of pairs) {
      const pa = a.pins[na]!;
      const pb = b.pins[nb]!;
      const netA = nets.netOf.get(pa.id);
      const netB = nets.netOf.get(pb.id);
      if (netA !== undefined && netB !== undefined && netA === netB) continue;

      const exclude = new Set([a.id, b.id]);
      const routed = routeWirePoints([pa.pos, pb.pos], {
        obstacles: routingObstacles(this.circuit, exclude),
        startDir: pinExitDir(pa.pos, a.pos),
        endDir: pinExitDir(pb.pos, b.pos),
        avoidCrossings: otherPaths,
        preferAlong: otherPaths.filter((_, j) => j >= otherPaths.length - n),
      });
      const mid = routed.slice(1, -1).map((p) => ({ x: p.x, y: p.y }));
      this.circuit.addWire(pa.id, pb.id, mid.length ? mid : undefined, bundleId);
      otherPaths.push(routed);
      n++;
      nets = this.circuit.computeNets();
    }
    return n;
  }

  private wireBankToHost(
    host: Component & { pins: Record<string, Pin>; pos: Point },
    banks: Array<Component & { pins: { out: Pin }; pos: Point }>,
    checkpoint: boolean,
  ): number {
    const sorted = [...banks].sort((a, b) => a.pos.y - b.pos.y || a.pos.x - b.pos.x);
    const prefixes = ['d', 'q', 'b', 'ch', 'a', 'in', 's', 'data', 'addr'] as const;
    let hostNames: string[] | null = null;
    for (const pref of prefixes) {
      const names: string[] = [];
      for (let i = 0; i < 64; i++) {
        const name = `${pref}${i}`;
        if (host.pins[name]) names.push(name);
        else break;
      }
      if (names.length >= 2) {
        hostNames = names;
        break;
      }
    }
    if (!hostNames || hostNames.length === 0) return 0;

    if (checkpoint) this.noteEdit();
    let nets = this.circuit.computeNets();
    let n = 0;
    const otherPaths: Point[][] = [];
    for (const ow of this.circuit.wires.values()) {
      const poly = rawWirePolyline(this.circuit, ow);
      if (poly) otherPaths.push(routeWirePoints(poly));
    }
    const bundleId = `bundle-${nextId('rb')}`;
    const count = Math.min(sorted.length, hostNames.length);
    for (let i = 0; i < count; i++) {
      const bank = sorted[i]!;
      const hostPin = host.pins[hostNames[i]!]!;
      const bankPin = bank.pins.out;
      const netA = nets.netOf.get(bankPin.id);
      const netB = nets.netOf.get(hostPin.id);
      if (netA !== undefined && netB !== undefined && netA === netB) continue;
      const exclude = new Set([host.id, bank.id]);
      const routed = routeWirePoints([bankPin.pos, hostPin.pos], {
        obstacles: routingObstacles(this.circuit, exclude),
        startDir: pinExitDir(bankPin.pos, bank.pos),
        endDir: pinExitDir(hostPin.pos, host.pos),
        avoidCrossings: otherPaths,
        preferAlong: otherPaths.filter((_, j) => j >= otherPaths.length - n),
      });
      const mid = routed.slice(1, -1).map((p) => ({ x: p.x, y: p.y }));
      this.circuit.addWire(bankPin.id, hostPin.id, mid.length ? mid : undefined, bundleId);
      otherPaths.push(routed);
      n++;
      nets = this.circuit.computeNets();
    }
    return n;
  }
}

/** Exact name pairs first, then bus remaps; each pin used at most once. */
function matchingPortPairs(
  pinsA: Record<string, Pin>,
  pinsB: Record<string, Pin>,
): { na: string; nb: string }[] {
  const pairs: { na: string; nb: string }[] = [];
  const usedA = new Set<string>();
  const usedB = new Set<string>();

  for (const name of Object.keys(pinsA)) {
    if (!pinsB[name]) continue;
    pairs.push({ na: name, nb: name });
    usedA.add(name);
    usedB.add(name);
  }

  const tryPair = (na: string, nb: string): void => {
    if (!pinsA[na] || !pinsB[nb]) return;
    if (usedA.has(na) || usedB.has(nb)) return;
    pairs.push({ na, nb });
    usedA.add(na);
    usedB.add(nb);
  };

  for (let i = 0; i < 32; i++) {
    // Register/counter/bus: q↔d, q↔b, d↔b (either orientation).
    tryPair(`q${i}`, `d${i}`);
    tryPair(`d${i}`, `q${i}`);
    tryPair(`q${i}`, `b${i}`);
    tryPair(`b${i}`, `q${i}`);
    tryPair(`d${i}`, `b${i}`);
    tryPair(`b${i}`, `d${i}`);
    // COMP-style aN ↔ bN across two chips / probe.
    tryPair(`a${i}`, `b${i}`);
    tryPair(`b${i}`, `a${i}`);
  }
  // sevenseg a..g ↔ chip a..g is already covered by exact names.
  return pairs;
}
