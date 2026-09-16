/**
 * ZX Spectrum .SCR screen dump: 6144 pixels + 768 attributes = 6912 bytes
 * from the display file (bank-relative $0000–$1AFF).
 */

import type { SpectrumMmu } from './mmu.js';

export const SCR_SIZE = 6912;

/** Read visible display bank into a .SCR buffer. */
export function saveScr(mmu: SpectrumMmu): Uint8Array {
  const bank = mmu.displayBank();
  return bank.subarray(0, SCR_SIZE).slice();
}

/** Write .SCR into the currently visible display bank (does not change border). */
export function loadScr(mmu: SpectrumMmu, data: Uint8Array): void {
  if (data.length !== SCR_SIZE) {
    throw new Error(`SCR must be ${SCR_SIZE} bytes (got ${data.length})`);
  }
  mmu.displayBank().set(data);
}
