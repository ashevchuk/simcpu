import { describe, expect, it } from 'vitest';
import { Circuit, bumpStructureVersion } from '../src/sim/Circuit.js';
import { makeBusPass, makeInput, makeLed, makeSwitch, wire } from '../src/sim/library.js';
import { initialState, step } from '../src/sim/solver.js';
import { busPassBitAt, busPassPaddleCenter } from '../src/ui/geometry.js';

describe('SPST switch / buspass net merge', () => {
  it('closed switch merges in↔out into one net; open keeps them apart', () => {
    const c = new Circuit();
    const sw = makeSwitch(c, { x: 0, y: 0 }, false);
    const netsOpen = c.computeNets();
    expect(netsOpen.netOf.get(sw.pins.in.id)).not.toBe(netsOpen.netOf.get(sw.pins.out.id));

    sw.closed = true;
    bumpStructureVersion();
    const netsClosed = c.computeNets();
    expect(netsClosed.netOf.get(sw.pins.in.id)).toBe(netsClosed.netOf.get(sw.pins.out.id));
  });

  it('closed switch passes a driven level to the far side', () => {
    const c = new Circuit();
    const inp = makeInput(c, 1, { x: -40, y: 0 });
    const sw = makeSwitch(c, { x: 0, y: 0 }, true);
    const led = makeLed(c, { x: 40, y: 0 });
    wire(c, inp.pins.out, sw.pins.in);
    wire(c, sw.pins.out, led.pins.in);
    const nets = c.computeNets();
    const state = step(c, nets, initialState());
    const net = nets.netOf.get(led.pins.in.id)!;
    expect(state.levelOf.get(net)).toBe(1);

    sw.closed = false;
    bumpStructureVersion();
    const nets2 = c.computeNets();
    const state2 = step(c, nets2, initialState());
    const net2 = nets2.netOf.get(led.pins.in.id)!;
    expect(state2.levelOf.get(net2)).toBe('Z');
  });

  it('buspass closes only selected poles', () => {
    const c = new Circuit();
    const bp = makeBusPass(c, 4, { x: 0, y: 0 }, 0b0101); // poles 0 and 2
    bumpStructureVersion();
    const nets = c.computeNets();
    expect(nets.netOf.get(bp.pins.a0!.id)).toBe(nets.netOf.get(bp.pins.b0!.id));
    expect(nets.netOf.get(bp.pins.a1!.id)).not.toBe(nets.netOf.get(bp.pins.b1!.id));
    expect(nets.netOf.get(bp.pins.a2!.id)).toBe(nets.netOf.get(bp.pins.b2!.id));
    expect(nets.netOf.get(bp.pins.a3!.id)).not.toBe(nets.netOf.get(bp.pins.b3!.id));
  });

  it('maps paddle click to pole index', () => {
    const c = new Circuit();
    const bp = makeBusPass(c, 4, { x: 100, y: 200 });
    for (let i = 0; i < 4; i++) {
      const center = busPassPaddleCenter(bp, i);
      expect(center).not.toBeNull();
      expect(busPassBitAt(bp, center!)).toBe(i);
    }
  });
});
