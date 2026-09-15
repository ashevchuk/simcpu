/**
 * Component orientation — rotates/mirrors pin offsets around the body center
 * so LEDs, buttons, etc. can face a chip for cleaner routing.
 */

import type { Component, Pin, Point } from './types.js';
import { LAYOUT, transistorPinOffsets } from './library.js';

export type Rotation = 0 | 90 | 180 | 270;

export function rotateCw(r: Rotation): Rotation {
  return ((r + 90) % 360) as Rotation;
}

export function rotateCcw(r: Rotation): Rotation {
  return ((r + 270) % 360) as Rotation;
}

/** Transform a local pin offset by optional mirror-X then CW rotation. */
export function transformOffset(
  dx: number,
  dy: number,
  rotation: Rotation = 0,
  mirrorX = false,
): Point {
  let x = mirrorX ? -dx : dx;
  let y = dy;
  let out: Point;
  switch (rotation) {
    case 90:
      out = { x: -y, y: x };
      break;
    case 180:
      out = { x: -x, y: -y };
      break;
    case 270:
      out = { x: y, y: -x };
      break;
    default:
      out = { x, y };
  }
  // Avoid signed zero from `-0` after rotations (breaks deep equality in tests / snaps).
  if (Object.is(out.x, -0)) out.x = 0;
  if (Object.is(out.y, -0)) out.y = 0;
  return out;
}

function setPin(pin: Pin, cx: number, cy: number, dx: number, dy: number, rot: Rotation, mirrorX: boolean): void {
  const t = transformOffset(dx, dy, rot, mirrorX);
  pin.pos = { x: cx + t.x, y: cy + t.y };
}

/** Components that support rotate / mirror in the inspector. */
export function isOrientable(c: Component): boolean {
  return (
    c.kind === 'transistor' ||
    c.kind === 'button' ||
    c.kind === 'led' ||
    c.kind === 'probe' ||
    c.kind === 'input' ||
    c.kind === 'source' ||
    c.kind === 'clock'
  );
}

export function getOrientation(c: Component): { rotation: Rotation; mirrorX: boolean } {
  if ('rotation' in c && typeof (c as { rotation?: Rotation }).rotation === 'number') {
    const rot = (c as { rotation: Rotation }).rotation;
    const mirrorX = 'mirrorX' in c && !!(c as { mirrorX?: boolean }).mirrorX;
    return { rotation: rot, mirrorX };
  }
  return { rotation: 0, mirrorX: false };
}

export function setOrientation(c: Component, rotation: Rotation, mirrorX: boolean): void {
  if (!isOrientable(c)) return;
  (c as { rotation: Rotation }).rotation = rotation;
  (c as { mirrorX: boolean }).mirrorX = mirrorX;
  applyPinLayout(c);
}

/**
 * Recompute absolute pin positions from the component's base LAYOUT offsets
 * and current orientation. Call after rotate/mirror or when restoring a save.
 */
export function applyPinLayout(c: Component): void {
  const { x: cx, y: cy } = c.pos;
  const { rotation, mirrorX } = getOrientation(c);

  switch (c.kind) {
    case 'transistor': {
      const off = transistorPinOffsets(c.type);
      setPin(c.pins.gate, cx, cy, off.gate[0], off.gate[1], rotation, mirrorX);
      setPin(c.pins.drain, cx, cy, off.drain[0], off.drain[1], rotation, mirrorX);
      setPin(c.pins.source, cx, cy, off.source[0], off.source[1], rotation, mirrorX);
      break;
    }
    case 'source':
      setPin(c.pins.out, cx, cy, LAYOUT.source.out[0], LAYOUT.source.out[1], rotation, mirrorX);
      break;
    case 'input':
      setPin(c.pins.out, cx, cy, LAYOUT.input.out[0], LAYOUT.input.out[1], rotation, mirrorX);
      break;
    case 'button':
      setPin(c.pins.out, cx, cy, LAYOUT.button.out[0], LAYOUT.button.out[1], rotation, mirrorX);
      break;
    case 'led':
      setPin(c.pins.in, cx, cy, LAYOUT.led.in[0], LAYOUT.led.in[1], rotation, mirrorX);
      break;
    case 'probe':
      setPin(c.pins.in, cx, cy, LAYOUT.probe.in[0], LAYOUT.probe.in[1], rotation, mirrorX);
      break;
    case 'clock':
      setPin(c.pins.out, cx, cy, LAYOUT.clock.out[0], LAYOUT.clock.out[1], rotation, mirrorX);
      setPin(c.pins.trig, cx, cy, LAYOUT.clock.trig[0], LAYOUT.clock.trig[1], rotation, mirrorX);
      break;
    default:
      break;
  }
}

/** Point on an axis-aligned body edge toward `target` (for stub drawing). */
export function bodyEdgeToward(
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  target: Point,
): Point {
  const dx = target.x - cx;
  const dy = target.y - cy;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return { x: cx, y: cy };
  const sx = Math.abs(dx) < 1e-6 ? Number.POSITIVE_INFINITY : halfW / Math.abs(dx);
  const sy = Math.abs(dy) < 1e-6 ? Number.POSITIVE_INFINITY : halfH / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}
