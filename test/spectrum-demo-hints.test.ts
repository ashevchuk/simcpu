import { describe, expect, it } from 'vitest';
import { joyMatrixKeys } from '../src/ui/SpectrumJoystick.js';
import { spectrumDemoHint } from '../src/ui/spectrumDemoHints.js';
import { LAB_CURRICULUM } from '../src/ui/LabCurriculum.js';

describe('Spectrum demo hints + WASD pad', () => {
  it('GLAZX prefers WASD with map/start hint', () => {
    const h = spectrumDemoHint('glazx');
    expect(h.joyMode).toBe('wasd');
    expect(h.padHint).toMatch(/W\/S/i);
    expect(h.teachExtra).toBeTruthy();
  });

  it('WASD mode maps up/fire to W/F', () => {
    const keys = joyMatrixKeys('wasd');
    expect(keys?.[3]).toBe('W');
    expect(keys?.[2]).toBe('S');
    expect(keys?.[1]).toBe('A');
    expect(keys?.[0]).toBe('D');
    expect(keys?.[4]).toBe('F');
    expect(joyMatrixKeys('kempston')).toBeNull();
  });
});

describe('Lab curriculum', () => {
  it('includes adder → ALU → soft RAM → contention → mini-CPU ladder', () => {
    const ids = LAB_CURRICULUM.map((s) => s.id);
    expect(ids).toContain('lab-adder4');
    expect(ids).toContain('lab-alu4');
    expect(ids).toContain('lab-soft-ram');
    expect(ids).toContain('lab-contend-bus');
    expect(ids).toContain('lab-mini-cpu');
    expect(ids.indexOf('lab-adder4')).toBeLessThan(ids.indexOf('lab-alu4'));
    expect(ids.indexOf('lab-soft-ram')).toBeLessThan(ids.indexOf('lab-contend-bus'));
    expect(ids.indexOf('lab-contend-bus')).toBeLessThan(ids.indexOf('lab-mini-cpu'));
    expect(LAB_CURRICULUM.find((s) => s.id === 'lab-alu4')?.checklist?.length).toBeGreaterThan(2);
  });
});
