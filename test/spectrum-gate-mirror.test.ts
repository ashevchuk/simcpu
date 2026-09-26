import { describe, expect, it } from 'vitest';
import { SpectrumMmu } from '../src/machine/spectrum/mmu.js';
import { loadSpectrum48Rom } from '../src/machine/spectrum/rom48.js';

describe('SpectrumMmu gate RAM mirror', () => {
  it('mirrorToFlatRam copies ROM + visible RAM into a flat 64K buffer', () => {
    const mmu = new SpectrumMmu();
    const rom = loadSpectrum48Rom();
    mmu.configure48(rom);
    mmu.write(0x4000, 0xab);
    mmu.write(0xc000, 0xcd);

    const flat = new Uint8Array(0x10000);
    flat.fill(0x55);
    mmu.mirrorToFlatRam(flat);

    expect(flat[0]).toBe(rom[0]); // DI
    expect(flat[0x3fff]).toBe(rom[0x3fff]);
    expect(flat[0x4000]).toBe(0xab);
    expect(flat[0xc000]).toBe(0xcd);
  });

  it('writeBackFromFlatRam updates display file in the MMU', () => {
    const mmu = new SpectrumMmu();
    mmu.configure48(loadSpectrum48Rom());
    const flat = new Uint8Array(0x10000);
    mmu.mirrorToFlatRam(flat);
    flat[0x4000] = 0x42;
    flat[0x5800] = 0x07; // attribute
    mmu.writeBackFromFlatRam(flat, 0x4000, 0x5b00);
    expect(mmu.read(0x4000)).toBe(0x42);
    expect(mmu.read(0x5800)).toBe(0x07);
    expect(mmu.screenDirty).toBe(true);
  });

  it('syncVisibleRam is used by mirrorToFlatRam for $4000–$FFFF', () => {
    const mmu = new SpectrumMmu();
    mmu.configure48(loadSpectrum48Rom());
    mmu.write(0x8000, 0x99);
    const flat = new Uint8Array(0x10000);
    mmu.syncVisibleRam(flat);
    expect(flat[0x8000]).toBe(0x99);
    expect(flat[0]).toBe(0); // ROM left alone
  });
});
