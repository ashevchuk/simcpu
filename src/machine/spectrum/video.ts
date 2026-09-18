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
  const px = pixelView(out);
  const pal = PALETTE32;

  // Border: top band, bottom band, then left/right strips per paper line.
  const bord = pal[border & 7]!;
  const topEnd = SPEC_BORDER * bw;
  px.fill(bord, 0, topEnd);
  px.fill(bord, (SPEC_BORDER + SPEC_SCREEN_H) * bw, SPEC_FRAME_H * bw);

  for (let y = 0; y < SPEC_SCREEN_H; y++) {
    const rowBase = (SPEC_BORDER + y) * bw;
    px.fill(bord, rowBase, rowBase + SPEC_BORDER);
    px.fill(bord, rowBase + SPEC_BORDER + SPEC_SCREEN_W, rowBase + bw);
    const lineAddr = pixBase + ((y & 0xc0) << 5) + ((y & 0x07) << 8) + ((y & 0x38) << 2);
    const attrRow = attrBase + (y >> 3) * 32;
    let o = rowBase + SPEC_BORDER;
    for (let col = 0; col < 32; col++) {
      const bits = screen[lineAddr + col]!;
      const attr = screen[attrRow + col]!;
      let ink = attr & 7;
      let paper = (attr >> 3) & 7;
      if (flashPhase && attr & 0x80) {
        const t = ink;
        ink = paper;
        paper = t;
      }
      const bright = attr & 0x40 ? 8 : 0;
      const inkC = pal[ink | bright]!;
      const paperC = pal[paper | bright]!;
      px[o++] = bits & 0x80 ? inkC : paperC;
      px[o++] = bits & 0x40 ? inkC : paperC;
      px[o++] = bits & 0x20 ? inkC : paperC;
      px[o++] = bits & 0x10 ? inkC : paperC;
      px[o++] = bits & 0x08 ? inkC : paperC;
      px[o++] = bits & 0x04 ? inkC : paperC;
      px[o++] = bits & 0x02 ? inkC : paperC;
      px[o++] = bits & 0x01 ? inkC : paperC;
    }
  }
}

/** Little-endian check once — Uint32 RGBA packing depends on it. */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x0a0b0c0d]).buffer)[0] === 0x0d;

function packRgba(r: number, g: number, b: number): number {
  return LITTLE_ENDIAN
    ? ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0
    : ((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0;
}

/** 16 packed colours: 0–7 normal, 8–15 bright. */
const PALETTE32: Uint32Array = (() => {
  const t = new Uint32Array(16);
  for (let i = 0; i < 8; i++) {
    const n = SPECTRUM_COLORS[i]!;
    const b = SPECTRUM_BRIGHT[i]!;
    t[i] = packRgba(n[0], n[1], n[2]);
    t[i + 8] = packRgba(b[0], b[1], b[2]);
  }
  return t;
})();

/** Uint32 view over an RGBA byte buffer (requires 4-byte alignment; callers allocate whole buffers). */
function pixelView(out: Uint8Array | Uint8ClampedArray): Uint32Array {
  if (out.byteOffset & 3) throw new Error('renderSpectrumFrame: RGBA buffer must be 4-byte aligned');
  return new Uint32Array(out.buffer, out.byteOffset, out.byteLength >> 2);
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
