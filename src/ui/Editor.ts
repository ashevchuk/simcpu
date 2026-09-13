import type { ChipLibrary } from '../sim/ChipLibrary.js';
import { Circuit } from '../sim/Circuit.js';
import {
  makeChipInstance,
  makeInput,
  makeLabel,
  makeProbe,
  makeSource,
  makeTransistor,
} from '../sim/library.js';
import type { Component, Point } from '../sim/types.js';
import { showPrompt } from './Dialog.js';
import { findComponentNear, findPinNear, findWaypointNear, findWireNear, snap } from './geometry.js';

export type Tool =
  | { kind: 'select' }
  | { kind: 'pan' } // dedicated hand tool; space+drag / middle-drag also pan regardless of tool, see main.ts
  | { kind: 'wire' }
  | { kind: 'nmos' }
  | { kind: 'pmos' }
  | { kind: 'vcc' }
  | { kind: 'gnd' }
  | { kind: 'input' }
  | { kind: 'probe' }
  | { kind: 'label' }
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
  /** At most one wire selected at a time — dragging a bend point or deleting a wire only ever concerns one. */
  selectedWireId: string | null = null;
  mouse: Point = { x: 0, y: 0 };
  marqueeStart: Point | null = null;
  dragging = false;
  hoveredComponentId: string | null = null;
  hoveredPinId: string | null = null;
  hoveredWireId: string | null = null;

  /** An existing bend point currently being dragged. */
  private dragWaypoint: { wireId: string; index: number } | null = null;
  /** Mousedown landed on a wire segment (not an existing bend point) — becomes a real inserted waypoint only past DRAG_THRESHOLD, so a plain click just selects the wire instead of kinking it. */
  private pendingWireGrab: { wireId: string; insertIndex: number; downPoint: Point } | null = null;
  /** Mousedown landed on a component — becomes an actual move only past DRAG_THRESHOLD, so a plain click still just (multi-)selects/toggles it. */
  private pendingComponentDrag: { ids: string[]; downPoint: Point } | null = null;
  /** The component(s) actually being dragged right now, and where the pointer was last frame (moves are applied as deltas, never absolute jumps). */
  private draggingComponents: { ids: string[]; lastPoint: Point } | null = null;

  /** True while a component or a wire's bend point is being actively dragged — for cursor feedback, see main.ts. */
  get isDragging(): boolean {
    return this.draggingComponents !== null || this.dragWaypoint !== null;
  }

  constructor(circuit: Circuit, readonly library: ChipLibrary) {
    this.circuit = circuit;
  }

  handleMouseMove(p: Point): void {
    this.mouse = p;
    this.hoveredComponentId = findComponentNear(this.circuit, p)?.id ?? null;
    this.hoveredPinId = findPinNear(this.circuit, p)?.id ?? null;
    this.hoveredWireId = (findWaypointNear(this.circuit, p)?.wireId ?? findWireNear(this.circuit, p)?.wireId) ?? null;
  }

  handleMouseDown(p: Point): void {
    if (this.tool.kind !== 'select') return;

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
      return;
    }

    this.marqueeStart = p;
    this.dragging = false;
  }

  handleMouseDrag(p: Point): void {
    if (this.pendingComponentDrag) {
      const { ids, downPoint } = this.pendingComponentDrag;
      if (Math.hypot(p.x - downPoint.x, p.y - downPoint.y) > DRAG_THRESHOLD) {
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
        const wire = this.circuit.wires.get(wireId);
        if (wire) {
          const waypoints = wire.waypoints ? [...wire.waypoints] : [];
          waypoints.splice(insertIndex, 0, p);
          wire.waypoints = waypoints;
        }
        this.dragWaypoint = { wireId, index: insertIndex };
        this.pendingWireGrab = null;
        this.dragging = true;
      }
      return;
    }
    if (this.dragWaypoint) {
      const wire = this.circuit.wires.get(this.dragWaypoint.wireId);
      if (wire?.waypoints) wire.waypoints[this.dragWaypoint.index] = p;
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
      if (!additive) this.selectedIds.clear();
      for (const c of this.circuit.components.values()) {
        if (c.pos.x >= x0 && c.pos.x <= x1 && c.pos.y >= y0 && c.pos.y <= y1) {
          this.selectedIds.add(c.id);
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
      const wire = this.circuit.wires.get(wp.wireId);
      if (wire?.waypoints) {
        wire.waypoints.splice(wp.index, 1);
        if (wire.waypoints.length === 0) delete wire.waypoints;
      }
    }
    return null;
  }

  handleDelete(): void {
    if (this.selectedWireId) {
      this.circuit.removeWire(this.selectedWireId);
      this.selectedWireId = null;
      return;
    }
    for (const id of this.selectedIds) this.circuit.removeComponent(id);
    this.selectedIds.clear();
  }

  /** Clears every kind of selection at once (components and the selected wire) — e.g. after clearing the circuit or navigating levels. */
  clearSelection(): void {
    this.selectedIds.clear();
    this.selectedWireId = null;
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
    const pin = findPinNear(this.circuit, p);
    if (!this.wireStartPinId) {
      if (pin) this.wireStartPinId = pin.id;
      return;
    }
    if (pin) {
      if (pin.id !== this.wireStartPinId) {
        this.circuit.addWire(this.wireStartPinId, pin.id, this.wireWaypoints.length ? [...this.wireWaypoints] : undefined);
      }
      this.cancelWire();
      return;
    }
    this.wireWaypoints.push(snap(p));
  }

  private placeAt(p: Point): void {
    switch (this.tool.kind) {
      case 'nmos':
        makeTransistor(this.circuit, 'N', p);
        break;
      case 'pmos':
        makeTransistor(this.circuit, 'P', p);
        break;
      case 'vcc':
        makeSource(this.circuit, 1, p);
        break;
      case 'gnd':
        makeSource(this.circuit, 0, p);
        break;
      case 'input':
        makeInput(this.circuit, 0, p);
        break;
      case 'probe':
        makeProbe(this.circuit, p);
        break;
      case 'label': {
        // Fire-and-forget: showPrompt() is async (a real DOM dialog, not a
        // blocking window.prompt()), but placeAt() itself stays synchronous
        // — nothing here needs to wait for the answer, the label just shows
        // up once the user answers.
        void showPrompt('Net name:', 'net').then((name) => {
          if (name) makeLabel(this.circuit, name, p);
        });
        break;
      }
      case 'place-chip': {
        const def = this.library.get(this.tool.defId);
        makeChipInstance(this.circuit, def, p);
        break;
      }
    }
  }
}
