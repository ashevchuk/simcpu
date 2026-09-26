import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { makeChipInstance, makeInput, makeLed, makeSource, wire } from '../src/sim/library.js';
import { ensureSoftState } from '../src/sim/softLab.js';
import { seedStandardCells } from '../src/sim/stdcells.js';
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

  it('paints Soft Lab REG8 / COUNTER4 softState.q onto q pins', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const circuit = new Circuit();
    makeSource(circuit, 1);
    makeSource(circuit, 0);
    const reg = makeChipInstance(circuit, library.findByName('REG8')!);
    const ctr = makeChipInstance(circuit, library.findByName('COUNTER4')!, { x: 400, y: 0 });
    const regSt = ensureSoftState(reg, 'REG8');
    regSt.q[0] = 1;
    regSt.q[3] = 1;
    const ctrSt = ensureSoftState(ctr, 'COUNTER4');
    ctrSt.q.fill(1); // 0xf → co high

    const resolve = makeSoftCanvasResolve(circuit);
    expect(resolve(reg.pins.q0!.id).level).toBe(1);
    expect(resolve(reg.pins.q1!.id).level).toBe(0);
    expect(resolve(reg.pins.q3!.id).level).toBe(1);
    expect(resolve(ctr.pins.q0!.id).level).toBe(1);
    expect(resolve(ctr.pins.co!.id).level).toBe(1);
  });
});
