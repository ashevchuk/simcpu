import { describe, expect, it } from 'vitest';
import { makeZ80Harness } from './z80Harness.js';
import { createSoftZ80, softStep } from '../src/machine/softZ80.js';

/**
 * Soft↔gate parity for EI delay and HALT latch (items that used to diverge).
 */
describe('soft↔gate EI delay / HALT', () => {
  it('EI then NOP enables IFF only after NOP (both sides)', () => {
    const program = new Uint8Array(128);
    program.set([0xed, 0x56, 0xfb, 0x00, 0x76], 0); // IM1 / EI / NOP / HALT

    const softRam = new Uint8Array(128);
    softRam.set(program);
    const soft = createSoftZ80(0x60);
    softStep(soft, softRam); // IM1
    softStep(soft, softRam); // EI
    expect(soft.iff1).toBe(false);
    softStep(soft, softRam); // NOP
    expect(soft.iff1).toBe(true);
    expect(soft.iff2).toBe(true);

    const h = makeZ80Harness(Uint8Array.from(program));
    h.runInstruction(); // IM1
    h.runInstruction(); // EI
    expect(h.readReg(h.cpu.iff1)).toBe(0);
    h.runInstruction(); // NOP — IFF commits PHASE2
    expect(h.readReg(h.cpu.iff1)).toBe(1);
    expect(h.readReg(h.cpu.iff2)).toBe(1);
  });

  it('HALT sets halted on both soft and gate', () => {
    const program = new Uint8Array([0x76]);
    const softRam = new Uint8Array(16);
    softRam.set(program);
    const soft = createSoftZ80(0);
    softStep(soft, softRam);
    expect(soft.halted).toBe(true);
    expect(soft.pc).toBe(1);

    const h = makeZ80Harness(Uint8Array.from(program));
    h.runInstruction();
    expect(h.readReg(h.cpu.halted)).toBe(1);
    expect(h.readReg(h.cpu.pc)).toBe(1);
  });
});
