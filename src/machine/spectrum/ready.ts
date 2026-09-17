/**
 * Detect soft Spectrum BASIC boot readiness from the display file / CPU / RGBA.
 * Used to time auto `LOAD ""` instead of a fixed sleep.
 */

import { screenHasNonBlankPixels } from './video.js';
import type { SpectrumMmu, SpectrumModel } from './mmu.js';
import type { SoftZ80State } from '../softZ80.js';

/** True when the visible screen has drawn something (© / menu / BASIC). */
export function spectrumScreenLooksReady(mmu: SpectrumMmu | null | undefined): boolean {
  if (!mmu) return false;
  return screenHasNonBlankPixels(mmu.displayBank());
}

/** True when a rendered RGBA frame has non-near-black pixels (Worker-safe). */
export function rgbaLooksReady(rgba: Uint8Array | null | undefined): boolean {
  if (!rgba || rgba.length < 64) return false;
  // Sample every 64th pixel (RGBA stride 4 → step 256 bytes)
  let colorful = 0;
  for (let i = 0; i + 2 < rgba.length; i += 256) {
    const r = rgba[i]!;
    const g = rgba[i + 1]!;
    const b = rgba[i + 2]!;
    if (r > 20 || g > 20 || b > 20) {
      colorful++;
      if (colorful >= 8) return true;
    }
  }
  return false;
}

/**
 * True when 48K/128 BASIC is likely sitting in an input/editor loop (IFF on).
 * 128 menu/editor ROM dwells lower; 48 editor/KEYBOARD is typically $0A00–$1F00.
 */
export function spectrumBasicAcceptsKeys(
  cpu: SoftZ80State | null | undefined,
  model?: SpectrumModel | null,
): boolean {
  if (!cpu || !cpu.iff1) return false;
  const pc = cpu.pc & 0xffff;
  if (pc >= 0x4000) return false; // left ROM
  if (model === '128') {
    // 128 editor / menu / 48 BASIC page — avoid PAUSE ($1F3D+) and NEW ($11xx early only loosely)
    return pc >= 0x0900 && pc < 0x1f00;
  }
  // 48K: Editor / KEYBOARD / MAIN-EXEC dwell below ROM PAUSE at $1F3D.
  return pc >= 0x0a00 && pc < 0x1f00;
}

function screenReady(
  getMmu: () => SpectrumMmu | null | undefined,
  getRgba?: () => Uint8Array | null | undefined,
): boolean {
  if (spectrumScreenLooksReady(getMmu())) return true;
  if (getRgba && rgbaLooksReady(getRgba())) return true;
  return false;
}

/**
 * Poll until the Spectrum screen shows activity or timeout.
 * Caller should keep soft Run active while waiting.
 */
export async function waitForSpectrumScreenReady(
  getMmu: () => SpectrumMmu | null | undefined,
  opts?: {
    timeoutMs?: number;
    pollMs?: number;
    minWaitMs?: number;
    getRgba?: () => Uint8Array | null | undefined;
  },
): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const pollMs = opts?.pollMs ?? 80;
  const minWaitMs = opts?.minWaitMs ?? 200;
  const t0 = performance.now();
  await sleep(minWaitMs);
  while (performance.now() - t0 < timeoutMs) {
    if (screenReady(getMmu, opts?.getRgba)) return true;
    await sleep(pollMs);
  }
  return screenReady(getMmu, opts?.getRgba);
}

/**
 * Screen activity plus BASIC input loop — safer gate for typing LOAD "".
 */
export async function waitForSpectrumBasicInputReady(
  getMmu: () => SpectrumMmu | null | undefined,
  getCpu: () => SoftZ80State | null | undefined,
  opts?: {
    timeoutMs?: number;
    pollMs?: number;
    minWaitMs?: number;
    getRgba?: () => Uint8Array | null | undefined;
    model?: () => SpectrumModel | null | undefined;
  },
): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? 12_000;
  const pollMs = opts?.pollMs ?? 80;
  const minWaitMs = opts?.minWaitMs ?? 400;
  const t0 = performance.now();
  await sleep(minWaitMs);
  let screenOk = false;
  while (performance.now() - t0 < timeoutMs) {
    if (!screenOk) screenOk = screenReady(getMmu, opts?.getRgba);
    const model = opts?.model?.() ?? null;
    if (screenOk && spectrumBasicAcceptsKeys(getCpu(), model)) return true;
    await sleep(pollMs);
  }
  const model = opts?.model?.() ?? null;
  return screenOk && spectrumBasicAcceptsKeys(getCpu(), model);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
