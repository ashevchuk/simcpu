import { describe, expect, it } from 'vitest';
import { makeZ80Harness } from './z80Harness.js';

/**
 * First CB-table body: register-only `BIT y,r` (see "CB x=01: BIT y,r" in
 * ARCHITECTURE.md). No `(HL)`, no rotates/SET/RES yet. Prefix mechanism
 * already spent PHASE2–3; the test commits flags at PHASE4.
 *
 * 0:  0x3E,0x08       LD A,0x08      bit 3 set
 * 2:  0xCB,0x5F       BIT 3,A        Z=0, H=1, X=1
 * 4:  0xCB,0x67       BIT 4,A        Z=1, H=1, P=1, X=1
 * 6:  0x06,0x80       LD B,0x80
 * 8:  0xCB,0x78       BIT 7,B        S=1, Z=0, H=1
 */
describe('buildZ80Cpu — CB x=01: BIT y,r (register form)', () => {
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0x3e, 0x08], 0);
    bytes.set([0xcb, 0x5f], 2);
    bytes.set([0xcb, 0x67], 4);
    bytes.set([0x06, 0x80], 6);
    bytes.set([0xcb, 0x78], 8);
    return bytes;
  })();

  // F: S Z Y H X P N C
  const F_BIT3_SET = 0b00011000; // H=1, X=1 (A bit3)
  const F_BIT4_CLEAR = 0b01011100; // Z=1, H=1, X=1, P=1 (=Z)
  const F_BIT7_SET = 0b10010000; // S=1, H=1

  it('tests a register bit and sets Z/H/N/S/P/X/Y, leaving C and the register alone', () => {
    const h = makeZ80Harness(PROGRAM);

    h.runInstruction(); // LD A,0x08
    expect(h.readReg(h.cpu.a)).toBe(0x08);

    h.runInstruction(); // BIT 3,A
    expect(h.readReg(h.cpu.a)).toBe(0x08);
    expect(h.readReg(h.cpu.f)).toBe(F_BIT3_SET);
    expect(h.readReg(h.cpu.pc)).toBe(4);

    h.runInstruction(); // BIT 4,A
    expect(h.readReg(h.cpu.a)).toBe(0x08);
    expect(h.readReg(h.cpu.f)).toBe(F_BIT4_CLEAR);
    expect(h.readReg(h.cpu.pc)).toBe(6);

    h.runInstruction(); // LD B,0x80
    expect(h.readReg(h.cpu.rB.q)).toBe(0x80);

    h.runInstruction(); // BIT 7,B
    expect(h.readReg(h.cpu.rB.q)).toBe(0x80);
    expect(h.readReg(h.cpu.f)).toBe(F_BIT7_SET);
    expect(h.readReg(h.cpu.pc)).toBe(10);
  });
});
