/**
 * ZX Spectrum screen renderer: 256×192 bitmap + attrs from a 16K display bank → RGBA.
 * Bank layout matches RAM bank 5/7: pixels at $0000, attributes at $1800.
 */

import { SPECTRUM_BRIGHT, SPECTRUM_COLORS } from './ula.js';

export const SPEC_SCREEN_W = 256;
export const SPEC_SCREEN_H = 192;
export const SPEC_BORDER = 32;
export const SPEC_FRAME_W = SPEC_SCREEN_W + SPEC_BORDER * 2;
export const SPEC_FRAME_H = SPEC_SCREEN_H + SPEC_BORDER * 2;

/** Half-period of ULA flash attribute (~16 frames at 50 Hz). */
export const SPEC_FLASH_HALF_MS = 320;

/** Flash phase from wall-clock (true = ink/paper swapped). */
export function spectrumFlashPhase(nowMs: number, epochMs = 0): boolean {
  return Math.floor((nowMs - epochMs) / SPEC_FLASH_HALF_MS) % 2 === 1;
}

/** Pixel base / attr base within a 16K display bank (or absolute $4000/$5800 in flat 64K). */
export const SCREEN_BANK_PIXELS = 0x0000;
export const SCREEN_BANK_ATTRS = 0x1800;
/** Legacy absolute addresses in a flat 64K map. */
export const SCREEN_BASE = 0x4000;
export const ATTR_BASE = 0x5800;

/** Spectrum display-file Y scramble: third / block / line (bank-relative offset). */
export function spectrumPixelAddress(x: number, y: number): number {
  const third = (y & 0xc0) << 5;
  const block = (y & 0x07) << 8;
  const line = (y & 0x38) << 2;
  return SCREEN_BANK_PIXELS + third + block + line + (x >> 3);
}

/**
 * Render Spectrum video RAM + border into an RGBA buffer
 * (SPEC_FRAME_W × SPEC_FRAME_H × 4).
 *
 * `screen` may be a 16K display bank (preferred) or a flat 64K map that still
 * holds the screen at $4000 (legacy). Detection: length < 0x5800+0x300 → bank.
 *
 * Flash attributes invert ink/paper when `flashPhase` is true. Callers should
 * toggle phase every {@link SPEC_FLASH_HALF_MS} (~16 frames @ 50 Hz).
 */
export function renderSpectrumFrame(
  screen: Uint8Array,
  border: number,
  out: Uint8Array | Uint8ClampedArray,
  flashPhase = false,
): void {
  const flat = screen.length >= 0x5b00;
  const pixBase = flat ? SCREEN_BASE : SCREEN_BANK_PIXELS;
  const attrBase = flat ? ATTR_BASE : SCREEN_BANK_ATTRS;
  const bw = SPEC_FRAME_W;
  const bh = SPEC_FRAME_H;
  const bord = SPECTRUM_COLORS[border & 7] ?? SPECTRUM_COLORS[7]!;

  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const o = (y * bw + x) * 4;
      out[o] = bord[0];
      out[o + 1] = bord[1];
      out[o + 2] = bord[2];
      out[o + 3] = 255;
    }
  }

  for (let y = 0; y < SPEC_SCREEN_H; y++) {
    for (let col = 0; col < 32; col++) {
      const addr = pixBase + spectrumPixelAddress(col * 8, y);
      const bits = screen[addr] ?? 0;
      const attr = screen[attrBase + ((y >> 3) * 32 + col)] ?? 0x38;
      let ink = attr & 7;
      let paper = (attr >> 3) & 7;
      const bright = (attr & 0x40) !== 0;
      const flash = (attr & 0x80) !== 0;
      if (flash && flashPhase) {
        const t = ink;
        ink = paper;
        paper = t;
      }
      const inkRgb = (bright ? SPECTRUM_BRIGHT : SPECTRUM_COLORS)[ink]!;
      const paperRgb = (bright ? SPECTRUM_BRIGHT : SPECTRUM_COLORS)[paper]!;
      for (let b = 0; b < 8; b++) {
        const on = (bits & (0x80 >> b)) !== 0;
        const rgb = on ? inkRgb : paperRgb;
        const x = SPEC_BORDER + col * 8 + b;
        const yy = SPEC_BORDER + y;
        const o = (yy * bw + x) * 4;
        out[o] = rgb[0];
        out[o + 1] = rgb[1];
        out[o + 2] = rgb[2];
        out[o + 3] = 255;
      }
    }
  }
}

/** True if pixel area looks non-blank (bank or flat). */
export function screenHasNonBlankPixels(screen: Uint8Array): boolean {
  const flat = screen.length >= 0x5b00;
  const start = flat ? SCREEN_BASE : SCREEN_BANK_PIXELS;
  const end = flat ? ATTR_BASE : SCREEN_BANK_ATTRS;
  for (let a = start; a < end; a++) {
    if ((screen[a] ?? 0) !== 0) return true;
  }
  return false;
}
