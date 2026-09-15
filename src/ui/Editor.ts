import type { ChipLibrary } from '../sim/ChipLibrary.js';
import { Circuit, nextId } from '../sim/Circuit.js';
import {
  makeAnalyzer,
  makeButton,
  makeChipInstance,
  makeClock,
  makeInput,
  makeLabel,
  makeLed,
  makePort,
  makeProbe,
  makeSource,
  makeTransistor,
  makeTty,
  nextAutoPortName,
  parseBusPortSpec,
} from '../sim/library.js';
import { firePulse } from '../sim/labTick.js';
import { applyPinLayout } from '../sim/orientation.js';
import { captureCircuit, type CircuitSnapshot } from '../sim/serialize.js';
import type { Component, Pin, Point } from '../sim/types.js';
import { showPrompt } from './Dialog.js';
import { findComponentNear, findPinNear, findWaypointNear, findWireNear, GRID, routeWirePoints, snap, wirePolyline } from './geometry.js';

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
  | { kind: 'clock' }
  | { kind: 'analyzer' }
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
  /** Drag a chip pin across the body center to flip left/right stack. */
  private pinSideDrag: { componentId: string; pinName: string; startX: number } | null = null;

  /** True while a component or a wire's bend point is being actively dragged — for cursor feedback, see main.ts. */
  get isDragging(): boolean {
    return this.draggingComponents !== null || this.dragWaypoint !== null;
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

  handleMouseDown(p: Point): void {
    if (this.tool.kind !== 'select') return;
    this.dragCheckpointTaken = false;

    // Chip pin → drag across center to flip side (before body hit-test).
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
          waypoints.splice(insertIndex, 0, snap(p));
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
      if (wire?.waypoints) wire.waypoints[this.dragWaypoint.index] = snap(p);
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
        const snapped = snap(c.pos);
        this.circuit.moveComponent(id, snapped.x - c.pos.x, snapped.y - c.pos.y);
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
      if (wire?.waypoints) wire.waypoints[this.dragWaypoint.index] = snap(p);
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
    for (const id of this.selectedIds) this.circuit.removeComponent(id);
    this.selectedIds.clear();
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

  private pasteSnapshot(snap: CircuitSnapshot, dx: number, dy: number): boolean {
    if (snap.components.length === 0) return false;
    const idMap = new Map<string, string>();
    const pinMap = new Map<string, string>();
    const newIds: string[] = [];

    for (const sc of snap.components) {
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
   * Re-route selected wires (or wires attached to selected components) with
   * fresh orthogonal waypoints — drops manual kinks.
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
    let n = 0;
    for (const id of wireIds) {
      const w = this.circuit.wires.get(id);
      if (!w) continue;
      const a = pinById.get(w.a);
      const b = pinById.get(w.b);
      if (!a || !b) continue;
      const routed = routeWirePoints([a.pos, b.pos]);
      const mid = routed.slice(1, -1);
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
    applyPinLayout(c);
    return c.pins[name]!.id;
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
    this.placeAt(snap(p));
  }

  /**
   * Click-to-route wiring: the first click on a pin starts the wire: each
   * further click on empty canvas commits a bend point (snapped to the
   * grid, like placement), and a click on a second pin completes the wire
   * as a polyline through every bend point collected so far — the standard
   * schematic-tool gesture (KiCad, Logisim, ...), not a one-shot straight
   * line. The waypoints are purely cosmetic (see Wire in types.ts): the
   * electrical net is exactly the same regardless of how the wire is routed.
   */
  private handleWireClick(p: Point): void {
    const pin = findPinNear(this.circuit, p, 22);
    if (!this.wireStartPinId) {
      if (pin) this.wireStartPinId = pin.id;
      return;
    }
    if (pin) {
      if (pin.id !== this.wireStartPinId) {
        this.noteEdit();
        this.circuit.addWire(this.wireStartPinId, pin.id, this.wireWaypoints.length ? [...this.wireWaypoints] : undefined);
      }
      this.cancelWire();
      return;
    }
    this.wireWaypoints.push(snap(p));
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
      case 'vcc':
        place(() => makeSource(this.circuit, 1, p));
        break;
      case 'gnd':
        place(() => makeSource(this.circuit, 0, p));
        break;
      case 'input':
        place(() => makeInput(this.circuit, 0, p));
        break;
      case 'button':
        place(() => makeButton(this.circuit, p));
        break;
      case 'led':
        place(() => makeLed(this.circuit, p));
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
        const def = this.library.get(this.tool.defId);
        place(() => makeChipInstance(this.circuit, def, p));
        break;
      }
    }
  }
}
