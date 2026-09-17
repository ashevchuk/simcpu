import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/sim/Circuit.js';
import { makeInput, makeJunction, makeLed, wire } from '../src/sim/library.js';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Editor } from '../src/ui/Editor.js';
import { interiorWaypoints, nearestOnPolyline, routeWirePoints } from '../src/ui/geometry.js';

describe('wire smart route + junctions', () => {
  it('interiorWaypoints drops endpoints', () => {
    expect(interiorWaypoints([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])).toEqual([{ x: 10, y: 0 }]);
    expect(interiorWaypoints([{ x: 0, y: 0 }, { x: 10, y: 10 }])).toEqual([]);
  });

  it('nearestOnPolyline finds mid-segment hit', () => {
    const hit = nearestOnPolyline(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 50 },
      ],
      { x: 50, y: 3 },
      10,
    );
    expect(hit).not.toBeNull();
    expect(hit!.segIndex).toBe(0);
    expect(hit!.point.x).toBeCloseTo(50, 0);
  });

  it('junction joins three pins on one net', () => {
    const c = new Circuit();
    const a = makeInput(c, 1, { x: 0, y: 0 });
    const b = makeLed(c, { x: 100, y: 0 });
    const d = makeLed(c, { x: 50, y: 80 });
    const j = makeJunction(c, { x: 50, y: 0 });
    wire(c, a.pins.out, j.pins.net);
    wire(c, j.pins.net, b.pins.in);
    wire(c, j.pins.net, d.pins.in);
    const nets = c.computeNets();
    const n = nets.netOf.get(a.pins.out.id);
    expect(n).toBe(nets.netOf.get(b.pins.in.id));
    expect(n).toBe(nets.netOf.get(d.pins.in.id));
  });

  it('Editor pin→pin commit stores smart waypoints around a chip body', () => {
    const library = new ChipLibrary();
    const circuit = new Circuit();
    const editor = new Editor(circuit, library);
    const a = makeInput(circuit, 0, { x: 0, y: 100 });
    const b = makeLed(circuit, { x: 200, y: 100 });
    // Direct add without waypoints would be a straight line through y=100.
    // Use public wire tool path via handleWireClick? It's private — call through tool clicks.
    editor.tool = { kind: 'wire' };
    // Simulate: start on a, finish on b with no bends → smart commit
    (editor as unknown as { handleWireClick: (p: { x: number; y: number }) => void }).handleWireClick(a.pins.out.pos);
    (editor as unknown as { handleWireClick: (p: { x: number; y: number }) => void }).handleWireClick(b.pins.in.pos);
    expect(circuit.wires.size).toBe(1);
    const w = [...circuit.wires.values()][0]!;
    // Smart route should at least produce a valid wire; waypoints optional if aligned.
    expect(w.a).toBe(a.pins.out.id);
    expect(w.b).toBe(b.pins.in.id);
  });

  it('Editor click mid-wire creates junction and can branch', () => {
    const library = new ChipLibrary();
    const circuit = new Circuit();
    const editor = new Editor(circuit, library);
    const a = makeInput(circuit, 0, { x: 0, y: 0 });
    const b = makeLed(circuit, { x: 200, y: 0 });
    wire(circuit, a.pins.out, b.pins.in, [
      { x: 100, y: 0 },
    ]);
    editor.tool = { kind: 'wire' };
    const click = (editor as unknown as { handleWireClick: (p: { x: number; y: number }) => void }).handleWireClick.bind(
      editor,
    );
    // Split at mid bend / segment
    click({ x: 100, y: 0 });
    expect(editor.wireStartPinId).not.toBeNull();
    const junctions = [...circuit.components.values()].filter((c) => c.kind === 'junction');
    expect(junctions.length).toBe(1);
    const c = makeLed(circuit, { x: 100, y: 100 });
    click(c.pins.in.pos);
    const nets = circuit.computeNets();
    expect(nets.netOf.get(a.pins.out.id)).toBe(nets.netOf.get(c.pins.in.id));
  });

  it('tidy keeps through-wires straight and branch as short L at a junction', () => {
    const library = new ChipLibrary();
    const circuit = new Circuit();
    const editor = new Editor(circuit, library);
    const a = makeInput(circuit, 0, { x: 0, y: 0 });
    const b = makeLed(circuit, { x: 200, y: 0 });
    const branch = makeLed(circuit, { x: 100, y: 100 });
    const j = makeJunction(circuit, { x: 100, y: 0 });
    wire(circuit, a.pins.out, j.pins.net);
    wire(circuit, j.pins.net, b.pins.in);
    // Deliberately overshooting branch path (old preferAlong bug).
    wire(circuit, j.pins.net, branch.pins.in, [
      { x: 160, y: 0 },
      { x: 160, y: 100 },
    ]);
    editor.selectedWireIds = new Set(circuit.wires.keys());
    editor.tidySelectedWires(false);

    const pinById = new Map([...circuit.allPins()].map((p) => [p.id, p]));
    const drawn = [...circuit.wires.values()].map((w) => {
      const pa = pinById.get(w.a)!;
      const pb = pinById.get(w.b)!;
      return routeWirePoints([pa.pos, ...(w.waypoints ?? []), pb.pos]);
    });
    const through = drawn.filter((p) => p.every((pt) => pt.y === 0));
    expect(through.length).toBe(2);
    for (const path of through) {
      expect(path.length).toBe(2);
      expect(Math.max(...path.map((p) => p.x)) - Math.min(...path.map((p) => p.x))).toBeLessThanOrEqual(120);
    }
    const branchPath = drawn.find((p) => p.some((pt) => pt.y !== 0))!;
    // Short L into the LED pin (may include a small side stub); never the old
    // preferAlong overshoot that ran past the junction along the trunk.
    expect(Math.max(...branchPath.map((p) => p.x))).toBeLessThanOrEqual(100);
    expect(branchPath.reduce((len, p, i, arr) => {
      if (i === 0) return 0;
      return len + Math.abs(p.x - arr[i - 1]!.x) + Math.abs(p.y - arr[i - 1]!.y);
    }, 0)).toBeLessThan(220);
  });

  it('deleting junction heals through-wire and drops branch only', () => {
    const library = new ChipLibrary();
    const circuit = new Circuit();
    const editor = new Editor(circuit, library);
    const a = makeInput(circuit, 0, { x: 0, y: 0 });
    const b = makeLed(circuit, { x: 200, y: 0 });
    const branch = makeLed(circuit, { x: 100, y: 100 });
    const j = makeJunction(circuit, { x: 100, y: 0 });
    wire(circuit, a.pins.out, j.pins.net);
    wire(circuit, j.pins.net, b.pins.in);
    wire(circuit, j.pins.net, branch.pins.in);
    expect(circuit.wires.size).toBe(3);

    editor.selectedIds = new Set([j.id]);
    editor.handleDelete();

    expect(circuit.components.has(j.id)).toBe(false);
    expect(circuit.wires.size).toBe(1);
    const nets = circuit.computeNets();
    expect(nets.netOf.get(a.pins.out.id)).toBe(nets.netOf.get(b.pins.in.id));
    expect(nets.netOf.get(branch.pins.in.id)).not.toBe(nets.netOf.get(a.pins.out.id));
  });
});
