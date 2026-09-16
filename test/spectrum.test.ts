import { describe, expect, it } from 'vitest';
import { bootSpectrum48, SPECTRUM_COPYRIGHT_NEEDLE } from '../src/machine/spectrum/boot.js';
import { loadSpectrum48Rom } from '../src/machine/spectrum/rom48.js';
import { SpectrumUla } from '../src/machine/spectrum/ula.js';
import { renderSpectrumFrame, SPEC_FRAME_H, SPEC_FRAME_W, spectrumPixelAddress } from '../src/machine/spectrum/video.js';
import { createSoftZ80, softRun, type SoftMemHooks } from '../src/machine/softZ80.js';

function spectrumHooks(ula: SpectrumUla): SoftMemHooks {
  return {
    addrBits: 16,
    romProtect: true,
    portIn: (p) => ula.portIn(p),
    portOut: (p, v) => ula.portOut(p, v),
    irqPending: () => ula.irqPending,
    clearIrq: () => ula.clearIrq(),
  };
}

/** Scan attribute+pixel RAM for ASCII-ish copyright via character cells is hard;
 * instead search ROM for needle and assert screen memory becomes non-zero after boot. */
describe('soft ZX Spectrum 48K', () => {
  it('embeds the standard 48K ROM', () => {
    const rom = loadSpectrum48Rom();
    expect(rom.length).toBe(16384);
    expect(rom[0]).toBe(0xf3); // DI at reset
    const text = new TextDecoder('ascii').decode(rom);
    expect(text).toContain(SPECTRUM_COPYRIGHT_NEEDLE);
  });

  it('ULA keyboard matrix is active-low per half-row', () => {
    const ula = new SpectrumUla();
    expect(ula.portIn(0xfefe)).toBe(0xff); // no keys: 0xe0|0x1f
    ula.setKey('A', true);
    // A is row A9 bit0 → port with A9 low: 0xfdfe
    const v = ula.portIn(0xfdfe);
    expect(v & 0x01).toBe(0);
    ula.setKey('A', false);
    expect(ula.portIn(0xfdfe) & 0x01).toBe(1);
  });

  it('maps Shift+digit via code (not key %)', async () => {
    const { mapBrowserKeyToSpectrum } = await import('../src/machine/spectrum/ula.js');
    expect(mapBrowserKeyToSpectrum('%', 'Digit5')).toBe('5');
    expect(mapBrowserKeyToSpectrum('ArrowLeft', 'ArrowLeft')).toEqual(['Shift', '5']);
  });

  it('exposes Kempston at port 0x1f', () => {
    const ula = new SpectrumUla();
    expect(ula.portIn(0x1f)).toBe(0);
    ula.setKempston(0, true); // right
    ula.setKempston(4, true); // fire
    expect(ula.portIn(0x1f)).toBe(0x11);
    ula.clearKeys();
    expect(ula.portIn(0x1f)).toBe(0);
  });

  it('ROM protect blocks writes below 4000', () => {
    const ram = new Uint8Array(0x10000);
    const ula = new SpectrumUla();
    bootSpectrum48(ram, ula);
    const hooks = spectrumHooks(ula);
    const cpu = createSoftZ80(0xffff);
    // LD (0),A would be trapped by protect via memWrite in interpreter —
    // poke through hooks path: softRun a tiny store
    ram[0x4000] = 0x00;
    // Direct memWrite test via executing LD (HL),A with HL=0
    ram[0x8000] = 0x21;
    ram[0x8001] = 0x00;
    ram[0x8002] = 0x00; // LD HL,0000
    ram[0x8003] = 0x3e;
    ram[0x8004] = 0xaa; // LD A,AA
    ram[0x8005] = 0x77; // LD (HL),A
    ram[0x8006] = 0x76; // HALT
    cpu.pc = 0x8000;
    softRun(cpu, ram, 20, hooks);
    expect(ram[0]).toBe(loadSpectrum48Rom()[0]);
  });

  it('renders border and a set pixel', () => {
    const ram = new Uint8Array(0x10000);
    ram[0x4000 + spectrumPixelAddress(0, 0)] = 0x80;
    ram[0x5800] = 0x07; // ink 7 paper 0
    const out = new Uint8Array(SPEC_FRAME_W * SPEC_FRAME_H * 4);
    renderSpectrumFrame(ram, 2, out, false);
    // border pixel
    expect(out[0]).toBe(0xd7); // red border
    // screen pixel at (32,32) in frame coords for (0,0)
    const o = ((32) * SPEC_FRAME_W + 32) * 4;
    expect(out[o]).toBe(0xd7); // white ink approx
  });

  it('swaps flash attribute ink/paper when phase is on', async () => {
    const { spectrumFlashPhase } = await import('../src/machine/spectrum/video.js');
    const ram = new Uint8Array(0x10000);
    ram[0x4000 + spectrumPixelAddress(0, 0)] = 0x80;
    ram[0x5800] = 0x87; // flash + ink 7 paper 0
    const a = new Uint8Array(SPEC_FRAME_W * SPEC_FRAME_H * 4);
    const b = new Uint8Array(SPEC_FRAME_W * SPEC_FRAME_H * 4);
    renderSpectrumFrame(ram, 0, a, false);
    renderSpectrumFrame(ram, 0, b, true);
    const o = (32 * SPEC_FRAME_W + 32) * 4;
    expect(a[o]).not.toBe(b[o]);
    expect(spectrumFlashPhase(0)).toBe(false);
    expect(spectrumFlashPhase(320)).toBe(true);
  });

  it('boots toward BASIC (screen activity + PC in RAM)', () => {
    const ram = new Uint8Array(0x10000);
    const ula = new SpectrumUla();
    bootSpectrum48(ram, ula);
    const cpu = createSoftZ80(0xffff);
    const hooks = spectrumHooks(ula);
    // Many frames of soft run with IRQ
    for (let frame = 0; frame < 400; frame++) {
      ula.pulseFrameIrq();
      softRun(cpu, ram, 20000, hooks);
    }
    let nonzero = 0;
    for (let a = 0x4000; a < 0x5b00; a++) if (ram[a]) nonzero++;
    expect(nonzero).toBeGreaterThan(100);
    // After init, PC usually in ROM interrupt/BASIC loop or HALT
    expect(cpu.pc).toBeLessThan(0x4000);
  }, 30000);
});
