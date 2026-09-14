import { describe, expect, it } from 'vitest';
import { makeZ80Harness } from './z80Harness.js';

/**
 * First FD/IY slice — LD IY,nn + PUSH IY + POP IY. Prefixed bodies start
 * at PHASE4 after the prefix burns PHASE2–3. See "FD: IY" in ARCHITECTURE.md.
 *
 *  0: FD 21 34 12   LD IY,0x1234
 *  4: FD E5         PUSH IY
 *  6: FD 21 00 00   LD IY,0x0000   (corrupt IY so POP must restore)
 * 10: FD E1         POP IY
 */
describe('buildZ80Cpu — FD: LD IY,nn / PUSH IY / POP IY', () => {
  const ADDR_BITS = 7;
  const SP0 = 0x60;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0xfd, 0x21, 0x34, 0x12], 0);
    bytes.set([0xfd, 0xe5], 4);
    bytes.set([0xfd, 0x21, 0x00, 0x00], 6);
    bytes.set([0xfd, 0xe1], 10);
    return bytes;
  })();

  it('loads IY from nn, pushes/pops through the stack, and restores IY', () => {
    const h = makeZ80Harness(PROGRAM, ADDR_BITS, (cpu, seedReg) => {
      seedReg(cpu.rB, 0);
      seedReg(cpu.rC, 0);
      seedReg(cpu.rD, 0);
      seedReg(cpu.rE, 0);
      seedReg(cpu.rH, 0);
      seedReg(cpu.rL, 0);
      seedReg(cpu.rIXH, 0);
      seedReg(cpu.rIXL, 0);
      seedReg(cpu.rIYH, 0);
      seedReg(cpu.rIYL, 0);
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

    h.runInstruction(); // LD IY,0x1234
    expect(h.readReg(h.cpu.rIYH.q)).toBe(0x12);
    expect(h.readReg(h.cpu.rIYL.q)).toBe(0x34);
    expect(h.readReg(h.cpu.pc)).toBe(4);

    h.runInstruction(); // PUSH IY
    expect(h.readReg(h.cpu.sp.q)).toBe(SP0 - 2);
    expect(h.cpu.ram.bytes[SP0 - 1]).toBe(0x12); // high byte first
    expect(h.cpu.ram.bytes[SP0 - 2]).toBe(0x34); // low byte second
    expect(h.readReg(h.cpu.pc)).toBe(6);

    h.runInstruction(); // LD IY,0x0000
    expect(h.readReg(h.cpu.rIYH.q)).toBe(0);
    expect(h.readReg(h.cpu.rIYL.q)).toBe(0);
    expect(h.readReg(h.cpu.pc)).toBe(10);

    h.runInstruction(); // POP IY
    expect(h.readReg(h.cpu.rIYH.q)).toBe(0x12);
    expect(h.readReg(h.cpu.rIYL.q)).toBe(0x34);
    expect(h.readReg(h.cpu.sp.q)).toBe(SP0);
    expect(h.readReg(h.cpu.pc)).toBe(12);
  });
});
