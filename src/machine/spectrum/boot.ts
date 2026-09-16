/**
 * Soft ZX Spectrum 48K / 128K boot helpers.
 */

import { SpectrumMmu, type SpectrumModel } from './mmu.js';
import { loadSpectrum48Rom } from './rom48.js';
import { loadSpectrum128Rom } from './rom128.js';
import { loadSpectrumTrdosRom } from './romTrdos.js';
import type { SpectrumUla } from './ula.js';

export const SPECTRUM_ROM_SIZE = 0x4000;

/** Write 48K ROM at 0000 only (keeps RAM). Legacy flat-RAM helper. */
export function loadSpectrumRom(ram: Uint8Array): void {
  if (ram.length < 0x10000) throw new Error('Spectrum 48K needs 64K RAM (addrBits=16)');
  const rom = loadSpectrum48Rom();
  if (rom.length !== SPECTRUM_ROM_SIZE) throw new Error('bad Spectrum ROM size');
  ram.set(rom, 0);
}

/** Configure MMU for 48K or 128K and clear RAM banks. */
export function bootSpectrum(
  mmu: SpectrumMmu,
  model: SpectrumModel,
  ula?: SpectrumUla,
): void {
  mmu.resetBanks();
  if (model === '128') {
    mmu.configure128(loadSpectrum128Rom());
  } else {
    mmu.configure48(loadSpectrum48Rom());
  }
  mmu.setTrdosRom(loadSpectrumTrdosRom());
  mmu.trdosPaged = false;
  ula?.reset();
}

/** Load 48K ROM at 0000, clear RAM 4000–FFFF (flat buffer), reset ULA. */
export function bootSpectrum48(ram: Uint8Array, ula?: SpectrumUla): void {
  loadSpectrumRom(ram);
  ram.fill(0, 0x4000);
  ula?.reset();
}

/** Boot soft Spectrum 128 via MMU (preferred path). */
export function bootSpectrum128(mmu: SpectrumMmu, ula?: SpectrumUla): void {
  bootSpectrum(mmu, '128', ula);
}

/** Copyright appears in ROM (final 'd' often has bit7 set in Spectrum charset). */
export const SPECTRUM_COPYRIGHT_NEEDLE = '1982 Sinclair Research Lt';
