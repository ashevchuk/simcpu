import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { makeButton, makeChipInstance, makeLed, makeRam } from '../src/sim/library.js';
import {
  applyPinLayout,
  getOrientation,
  rotateCw,
  setOrientation,
  transformOffset,
} from '../src/sim/orientation.js';
import { seedStandardCells } from '../src/sim/stdcells.js';
import { Editor } from '../src/ui/Editor.js';
import { routeWirePoints } from '../src/ui/geometry.js';

describe('orientation', () => {
  it('transformOffset rotates CW', () => {
    expect(transformOffset(16, 0, 0, false)).toEqual({ x: 16, y: 0 });
    expect(transformOffset(16, 0, 90, false)).toEqual({ x: 0, y: 16 });
    expect(transformOffset(16, 0, 180, false)).toEqual({ x: -16, y: 0 });
    expect(transformOffset(16, 0, 180, true)).toEqual({ x: 16, y: 0 });
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
    const expected = routeWirePoints([a.pins.in.pos, b.pins.in.pos]).slice(1, -1);
    expect(w.waypoints ?? []).toEqual(expected);
  });
});
