import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/sim/Circuit.js';
import { makeButton, makeLed } from '../src/sim/library.js';
import {
  applyPinLayout,
  getOrientation,
  rotateCw,
  setOrientation,
  transformOffset,
} from '../src/sim/orientation.js';

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
});
