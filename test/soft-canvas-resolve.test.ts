import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/sim/Circuit.js';
import { makeInput, makeLed, makeSource, wire } from '../src/sim/library.js';
import { makeSoftCanvasResolve } from '../src/ui/softCanvasResolve.js';

describe('makeSoftCanvasResolve', () => {
  it('paints Input-driven nets (lab LED blink path) instead of Z', () => {
    const circuit = new Circuit();
    makeSource(circuit, 1);
    makeSource(circuit, 0);
    const drive = makeInput(circuit, 0);
    const led = makeLed(circuit, { x: 40, y: 0 }, 'LAB_LED');
    wire(circuit, drive.pins.out, led.pins.in);

    let resolve = makeSoftCanvasResolve(circuit);
    expect(resolve(led.pins.in.id).level).toBe(0);
    expect(resolve(drive.pins.out.id).level).toBe(0);

    drive.value = 1;
    led.forceOn = true;
    resolve = makeSoftCanvasResolve(circuit);
    expect(resolve(led.pins.in.id).level).toBe(1);
    expect(resolve(drive.pins.out.id).level).toBe(1);
  });

  it('uses LED forceOn when no Input is present', () => {
    const circuit = new Circuit();
    const led = makeLed(circuit, { x: 0, y: 0 }, 'LAB_LED');
    led.forceOn = true;
    const resolve = makeSoftCanvasResolve(circuit);
    expect(resolve(led.pins.in.id).level).toBe(1);
  });

  it('leaves undriven nets as Z', () => {
    const circuit = new Circuit();
    const led = makeLed(circuit, { x: 0, y: 0 });
    const resolve = makeSoftCanvasResolve(circuit);
    expect(resolve(led.pins.in.id)).toEqual({ level: 'Z', contended: false });
  });
});
