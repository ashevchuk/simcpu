import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { makeButton, makeChipInstance, makeLed, makeRam, makeSource } from '../src/sim/library.js';
import {
  applyPinLayout,
  getOrientation,
  rotateCw,
  setOrientation,
  transformOffset,
} from '../src/sim/orientation.js';
import { seedStandardCells } from '../src/sim/stdcells.js';
import { Editor } from '../src/ui/Editor.js';
import { pathOverlapLength, routeWirePoints } from '../src/ui/geometry.js';

describe('orientation', () => {
  it('transformOffset rotates CW', () => {
    expect(transformOffset(16, 0, 0, false)).toEqual({ x: 16, y: 0 });
    expect(transformOffset(16, 0, 90, false)).toEqual({ x: 0, y: 16 });
    expect(transformOffset(16, 0, 180, false)).toEqual({ x: -16, y: 0 });
    expect(transformOffset(16, 0, 180, true)).toEqual({ x: 16, y: 0 });
  });

  it('transformOffset flips H and V before rotation', () => {
    expect(transformOffset(10, 4, 0, true, false)).toEqual({ x: -10, y: 4 });
    expect(transformOffset(10, 4, 0, false, true)).toEqual({ x: 10, y: -4 });
    expect(transformOffset(10, 4, 0, true, true)).toEqual({ x: -10, y: -4 });
    expect(transformOffset(0, 15, 90, false, false)).toEqual({ x: -15, y: 0 });
    expect(transformOffset(0, 15, 90, true, false)).toEqual({ x: -15, y: 0 });
    expect(transformOffset(0, 15, 90, false, true)).toEqual({ x: 15, y: 0 });
  });

  it('source pin swings with rotation and flips', () => {
    const c = new Circuit();
    const src = makeSource(c, 1, { x: 0, y: 0 });
    expect(src.pins.out.pos).toEqual({ x: 0, y: 15 });
    setOrientation(src, 90, false, false);
    expect(src.pins.out.pos).toEqual({ x: -15, y: 0 });
    setOrientation(src, 0, false, true);
    expect(src.pins.out.pos).toEqual({ x: 0, y: -15 });
    setOrientation(src, 0, true, false);
    expect(src.pins.out.pos).toEqual({ x: 0, y: 15 });
  });

  it('rotate preserves flip flags', () => {
    const c = new Circuit();
    const led = makeLed(c, { x: 0, y: 0 });
    setOrientation(led, 0, true, true);
    setOrientation(led, rotateCw(0), true, true);
    expect(getOrientation(led)).toEqual({ rotation: 90, mirrorX: true, mirrorY: true });
  });

  it('LED pin swings with rotation so it can face a chip', () => {
    const c = new Circuit();
    const led = makeLed(c, { x: 100, y: 100 });
    expect(led.pins.in.pos.x).toBeLessThan(led.pos.x);
    setOrientation(led, 180, false);
    expect(led.pins.in.pos.x).toBeGreaterThan(led.pos.x);
    expect(getOrientation(led).rotation).toBe(180);
  });

  it('button rotateCw cycles', () => {
    const c = new Circuit();
    const btn = makeButton(c, { x: 0, y: 0 });
    setOrientation(btn, rotateCw(0), false);
    applyPinLayout(btn);
    expect(btn.pins.out.pos).toEqual({ x: 0, y: 16 });
  });

  it('chip / RAM pins flip to the right at 180°', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const c = new Circuit();
    const nandDef = library.list().find((d) => d.name === 'NAND' || d.id === 'NAND');
    expect(nandDef).toBeTruthy();
    const nand = makeChipInstance(c, nandDef!, { x: 0, y: 0 });
    const leftX = nand.pins.a!.pos.x;
    expect(leftX).toBeLessThan(0);
    setOrientation(nand, 180, false);
    expect(nand.pins.a!.pos.x).toBeGreaterThan(0);
    expect(nand.pins.a!.pos.x).toBeCloseTo(-leftX, 5);

    const ram = makeRam(c, 4, 8, undefined, { x: 200, y: 0 });
    const addr0 = ram.pins.addr0!.pos.x;
    setOrientation(ram, 180, false);
    expect(ram.pins.addr0!.pos.x).toBeGreaterThan(ram.pos.x);
    expect(ram.pins.addr0!.pos.x - ram.pos.x).toBeCloseTo(-(addr0 - ram.pos.x), 5);
  });
});

describe('wire tidy', () => {
  it('tidySelectedWires rebuilds orthogonal waypoints', () => {
    const library = new ChipLibrary();
    const c = new Circuit();
    const a = makeLed(c, { x: 0, y: 0 });
    const b = makeLed(c, { x: 100, y: 60 });
    const w = c.addWire(a.pins.in.id, b.pins.in.id, [
      { x: 10, y: 50 },
      { x: 90, y: 10 },
    ]);
    const editor = new Editor(c, library);
    editor.selectedWireId = w.id;
    expect(editor.tidySelectedWires()).toBe(1);
    // Pin-exit-aware tidy replaces manual kinks with a clean ortho path.
    const mid = w.waypoints ?? [];
    expect(mid.length).toBeGreaterThanOrEqual(1);
    expect(mid).not.toEqual([
      { x: 10, y: 50 },
      { x: 90, y: 10 },
    ]);
    const drawn = routeWirePoints([a.pins.in.pos, ...mid, b.pins.in.pos]);
    expect(drawn[0]).toEqual(a.pins.in.pos);
    expect(drawn[drawn.length - 1]).toEqual(b.pins.in.pos);
  });

  it('tidyAllWires spreads parallel fanouts onto distinct channels', () => {
    const library = new ChipLibrary();
    const c = new Circuit();
    const wires = [];
    for (let i = 0; i < 4; i++) {
      const a = makeButton(c, { x: 0, y: i * 20 }, 'toggle');
      const b = makeLed(c, { x: 200, y: 10 + i * 20 });
      wires.push(c.addWire(a.pins.out.id, b.pins.in.id));
    }
    const editor = new Editor(c, library);
    expect(editor.tidyAllWires()).toBe(4);
    const paths = wires.map((w) => {
      const pinA = [...c.allPins()].find((p) => p.id === w.a)!;
      const pinB = [...c.allPins()].find((p) => p.id === w.b)!;
      return routeWirePoints([pinA.pos, ...(w.waypoints ?? []), pinB.pos]);
    });
    for (let i = 0; i < paths.length; i++) {
      for (let j = i + 1; j < paths.length; j++) {
        expect(pathOverlapLength(paths[i]!, [paths[j]!])).toBe(0);
      }
    }
  });

  it('formatNetName prefers label names', () => {
    const library = new ChipLibrary();
    const c = new Circuit();
    const editor = new Editor(c, library);
    expect(editor.formatNetName('VCC')).toBe('VCC');
    expect(editor.formatNetName('chip1:a')).toMatch(/^chip1/);
  });
});

describe('align / distribute', () => {
  it('alignSelection snaps X to leftmost', () => {
    const library = new ChipLibrary();
    const c = new Circuit();
    const a = makeLed(c, { x: 40, y: 0 });
    const b = makeLed(c, { x: 100, y: 40 });
    const editor = new Editor(c, library);
    editor.selectedIds = new Set([a.id, b.id]);
    expect(editor.alignSelection('x', 'min')).toBe(2);
    expect(a.pos.x).toBe(40);
    expect(b.pos.x).toBe(40);
  });

  it('distributeSelection spaces three parts on X', () => {
    const library = new ChipLibrary();
    const c = new Circuit();
    const a = makeLed(c, { x: 0, y: 0 });
    const b = makeLed(c, { x: 20, y: 0 });
    const d = makeLed(c, { x: 100, y: 0 });
    const editor = new Editor(c, library);
    editor.selectedIds = new Set([a.id, b.id, d.id]);
    expect(editor.distributeSelection('x')).toBe(3);
    expect(a.pos.x).toBe(0);
    expect(d.pos.x).toBe(100);
    expect(b.pos.x).toBe(50);
  });
});

describe('pin order', () => {
  it('swapping pinOrder moves chip pin positions', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const c = new Circuit();
    const nandDef = library.list().find((d) => d.name === 'NAND')!;
    const nand = makeChipInstance(c, nandDef, { x: 0, y: 0 });
    const yA = nand.pins.a!.pos.y;
    const yB = nand.pins.b!.pos.y;
    expect(yA).toBeLessThan(yB);
    const i = nand.pinOrder.indexOf('a');
    const j = nand.pinOrder.indexOf('b');
    const tmp = nand.pinOrder[i]!;
    nand.pinOrder[i] = nand.pinOrder[j]!;
    nand.pinOrder[j] = tmp;
    applyPinLayout(nand);
    expect(nand.pins.a!.pos.y).toBe(yB);
    expect(nand.pins.b!.pos.y).toBe(yA);
  });
});
