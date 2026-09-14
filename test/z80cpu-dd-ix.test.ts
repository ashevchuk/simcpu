import { describe, expect, it } from 'vitest';
import { makeZ80Harness } from './z80Harness.js';

/**
 * First DD/IX slice — LD IX,nn + PUSH IX + POP IX. Prefixed bodies start
 * at PHASE4 after the prefix burns PHASE2–3. See "DD: IX" in ARCHITECTURE.md.
 *
 *  0: DD 21 34 12   LD IX,0x1234
 *  4: DD E5         PUSH IX
 *  6: DD 21 00 00   LD IX,0x0000   (corrupt IX so POP must restore)
 * 10: DD E1         POP IX
 */
describe('buildZ80Cpu — DD: LD IX,nn / PUSH IX / POP IX', () => {
  const ADDR_BITS = 7;
  const SP0 = 0x60;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0xdd, 0x21, 0x34, 0x12], 0);
    bytes.set([0xdd, 0xe5], 4);
    bytes.set([0xdd, 0x21, 0x00, 0x00], 6);
    bytes.set([0xdd, 0xe1], 10);
    return bytes;
  })();

  it('loads IX from nn, pushes/pops through the stack, and restores IX', () => {
    const h = makeZ80Harness(PROGRAM, ADDR_BITS, (cpu, seedReg) => {
      seedReg(cpu.rB, 0);
      seedReg(cpu.rC, 0);
      seedReg(cpu.rD, 0);
      seedReg(cpu.rE, 0);
      seedReg(cpu.rH, 0);
      seedReg(cpu.rL, 0);
      seedReg(cpu.rIXH, 0);
      seedReg(cpu.rIXL, 0);
      seedReg(cpu.sp, SP0, ADDR_BITS);
      seedReg(cpu.aP, 0);
      seedReg(cpu.fP, 0);
      seedReg(cpu.bP, 0);
      seedReg(cpu.cP, 0);
      seedReg(cpu.dP, 0);
      seedReg(cpu.eP, 0);
      seedReg(cpu.hP, 0);
      seedReg(cpu.lP, 0);
    });

    h.runInstruction(); // LD IX,0x1234
    expect(h.readReg(h.cpu.rIXH.q)).toBe(0x12);
    expect(h.readReg(h.cpu.rIXL.q)).toBe(0x34);
    expect(h.readReg(h.cpu.pc)).toBe(4);

    h.runInstruction(); // PUSH IX
    expect(h.readReg(h.cpu.sp.q)).toBe(SP0 - 2);
    expect(h.cpu.ram.bytes[SP0 - 1]).toBe(0x12); // high byte first
    expect(h.cpu.ram.bytes[SP0 - 2]).toBe(0x34); // low byte second
    expect(h.readReg(h.cpu.pc)).toBe(6);

    h.runInstruction(); // LD IX,0x0000
    expect(h.readReg(h.cpu.rIXH.q)).toBe(0);
    expect(h.readReg(h.cpu.rIXL.q)).toBe(0);
    expect(h.readReg(h.cpu.pc)).toBe(10);

    h.runInstruction(); // POP IX
    expect(h.readReg(h.cpu.rIXH.q)).toBe(0x12);
    expect(h.readReg(h.cpu.rIXL.q)).toBe(0x34);
    expect(h.readReg(h.cpu.sp.q)).toBe(SP0);
    expect(h.readReg(h.cpu.pc)).toBe(12);
  });
});
