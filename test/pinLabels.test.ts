import { describe, expect, it } from 'vitest';
import { formatPinLabel, pinLabelEdge } from '../src/ui/Renderer.js';

describe('pinLabelEdge', () => {
  it('keeps tall left-stack corner pins on the left (busprobe-like)', () => {
    const cx = 0;
    const cy = 0;
    const w = 78;
    const h = (8 - 1) * 20 + 28; // matches Renderer busprobe
    // analyzer pitch ±70 for 8 pins
    const pins = [-70, -50, -30, -10, 10, 30, 50, 70].map((dy) => ({ x: -28, y: dy }));
    for (const p of pins) {
      expect(pinLabelEdge(p, cx, cy, w, h), `pin y=${p.y}`).toBe('left');
    }
  });

  it('keeps corners left even on a short body (old busprobe height)', () => {
    const w = 78;
    const h = 8 * 16 + 16; // legacy short body that used to steal B0/B7
    for (const dy of [-70, 70]) {
      expect(pinLabelEdge({ x: -28, y: dy }, 0, 0, w, h), `y=${dy}`).toBe('left');
    }
  });

  it('classifies true top/bottom pins', () => {
    expect(pinLabelEdge({ x: 0, y: -40 }, 0, 0, 60, 40)).toBe('top');
    expect(pinLabelEdge({ x: 0, y: 40 }, 0, 0, 60, 40)).toBe('bottom');
  });

  it('classifies right-stack pins', () => {
    expect(pinLabelEdge({ x: 40, y: -20 }, 0, 0, 80, 80)).toBe('right');
    expect(pinLabelEdge({ x: 40, y: 20 }, 0, 0, 80, 80)).toBe('right');
  });
});

describe('formatPinLabel', () => {
  it('formats bus and channel names', () => {
    expect(formatPinLabel('b0')).toBe('B0');
    expect(formatPinLabel('b7')).toBe('B7');
    expect(formatPinLabel('ch3')).toBe('CH3');
    expect(formatPinLabel('addr12')).toBe('A12');
  });
});
