/**
 * Decode every bundled Spectrum fixture and smoke-apply parsers.
 */
import { describe, expect, it } from 'vitest';
import {
  SPECTRUM_GAMES,
  decodeSpectrumGame,
} from '../src/machine/spectrum/gamesData.js';
import { parseTap } from '../src/machine/spectrum/tap.js';
import { applySna, isSna48, isSna128 } from '../src/machine/spectrum/sna.js';
import { SpectrumMmu } from '../src/machine/spectrum/mmu.js';
import { SpectrumUla } from '../src/machine/spectrum/ula.js';
import { bootSpectrum } from '../src/machine/spectrum/boot.js';
import { createSoftZ80 } from '../src/machine/softZ80.js';

describe('bundled Spectrum games catalog', () => {
  it('has expected demo ids', () => {
    const ids = SPECTRUM_GAMES.map((g) => g.id).sort();
    expect(ids).toEqual(
      ['ay-beep', 'egghead', 'egghead-space', 'glazx', 'homebrew', 'pzxl', 'rainbow'].sort(),
    );
  });

  for (const entry of SPECTRUM_GAMES) {
    it(`decodes ${entry.id} (${entry.kind})`, () => {
      const buf = decodeSpectrumGame(entry);
      expect(buf.length).toBeGreaterThan(100);
      if (entry.kind === 'sna') {
        expect(isSna48(buf) || isSna128(buf)).toBe(true);
        const mmu = new SpectrumMmu();
        const ula = new SpectrumUla();
        bootSpectrum(mmu, '48', ula);
        const cpu = createSoftZ80(0xffff);
        const r = applySna(mmu, cpu, ula, buf);
        expect(r.pc).toBeGreaterThanOrEqual(0);
        expect(r.pc).toBeLessThanOrEqual(0xffff);
      } else {
        const blocks = parseTap(buf);
        expect(blocks.length).toBeGreaterThan(0);
        // First TAP block is usually a header (flag 0)
        expect(blocks[0]!.flag).toBeDefined();
      }
    });
  }
});
