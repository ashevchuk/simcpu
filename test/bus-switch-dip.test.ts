import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/sim/Circuit.js';
import { makeBusSwitch } from '../src/sim/library.js';
import { busSwitchBitAt, busSwitchPaddleCenter } from '../src/ui/geometry.js';

describe('DIP bus switch hit-test', () => {
  it('maps click on paddle to bit index (LSB = b0)', () => {
    const circuit = new Circuit();
    const sw = makeBusSwitch(circuit, 4, { x: 100, y: 200 }, 'hex', 0);
    for (let i = 0; i < 4; i++) {
      const center = busSwitchPaddleCenter(sw, i);
      expect(center).not.toBeNull();
      expect(busSwitchBitAt(sw, center!)).toBe(i);
    }
  });

  it('places every pin on the bank side (not top/bottom for end bits)', () => {
    const circuit = new Circuit();
    const sw = makeBusSwitch(circuit, 8, { x: 100, y: 200 }, 'hex', 0);
    for (let i = 0; i < 8; i++) {
      const pin = sw.pins[`b${i}`]!;
      // Right of body center; same X for the whole stack.
      expect(pin.pos.x).toBeGreaterThan(sw.pos.x + 40);
      expect(pin.pos.x).toBeCloseTo(sw.pins.b0!.pos.x, 5);
    }
  });

  it('keeps paddle on the same row as its pin (no vertical squash)', () => {
    const circuit = new Circuit();
    const sw = makeBusSwitch(circuit, 8, { x: 100, y: 200 }, 'hex', 0);
    for (let i = 0; i < 8; i++) {
      const pin = sw.pins[`b${i}`]!;
      const pad = busSwitchPaddleCenter(sw, i)!;
      expect(pad.y).toBeCloseTo(pin.pos.y, 5);
      expect(pad.x).toBeLessThan(pin.pos.x);
    }
  });

  it('returns null away from paddles (readout / empty)', () => {
    const circuit = new Circuit();
    const sw = makeBusSwitch(circuit, 4, { x: 100, y: 200 }, 'hex', 0xa);
    // Far left of package — readout zone, not a rocker.
    expect(busSwitchBitAt(sw, { x: sw.pos.x - 36, y: sw.pos.y })).toBeNull();
  });

  it('toggling bit i flips only that bit (fixes hex+4-bit no-op)', () => {
    const circuit = new Circuit();
    const sw = makeBusSwitch(circuit, 4, { x: 0, y: 0 }, 'hex', 0xa); // 1010
    // Simulate Editor: xor bit 0
    sw.value ^= 1 << 0;
    expect(sw.value).toBe(0xb); // 1011
    sw.value ^= 1 << 1;
    expect(sw.value).toBe(0x9); // 1001
    // Whole-value step always changes 4-bit (unlike old +0x10 & 0xF)
    const mask = (1 << 4) - 1;
    const before = sw.value;
    sw.value = (sw.value + 1) & mask;
    expect(sw.value).not.toBe(before);
  });
});
