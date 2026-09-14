import { describe, expect, it } from 'vitest';
import { makeZ80Harness } from './z80Harness.js';

/**
 * CB `BIT` column — see "CB x=01: BIT y,r / BIT y,(HL)" in ARCHITECTURE.md.
 * Register form is flags-only at PHASE4; (HL) reads at PHASE4 and commits
 * flags at PHASE5. Neither writes memory or registers.
 */
describe('buildZ80Cpu — CB x=01: BIT y,r / BIT y,(HL)', () => {
  // F: S Z Y H X P N C
  const F_BIT3_SET = 0b00011000; // H=1, X=1 (source bit3)
  const F_BIT4_CLEAR = 0b01011100; // Z=1, H=1, X=1, P=1 (=Z)
  const F_BIT7_SET = 0b10010000; // S=1, H=1 (X=0 — for 0x80)
  const F_BIT7_SET_X = 0b10011000; // S=1, H=1, X=1 (for 0x88)

  it('BIT y,r tests a register bit and leaves the register alone', () => {
    const PROGRAM = (() => {
      const bytes = new Uint8Array(128);
      bytes.set([0x3e, 0x08], 0); // LD A,0x08
      bytes.set([0xcb, 0x5f], 2); // BIT 3,A
      bytes.set([0xcb, 0x67], 4); // BIT 4,A
      bytes.set([0x06, 0x80], 6); // LD B,0x80
      bytes.set([0xcb, 0x78], 8); // BIT 7,B
      return bytes;
    })();
    const h = makeZ80Harness(PROGRAM);

    h.runInstruction();
    expect(h.readReg(h.cpu.a)).toBe(0x08);

    h.runInstruction();
    expect(h.readReg(h.cpu.a)).toBe(0x08);
    expect(h.readReg(h.cpu.f)).toBe(F_BIT3_SET);
    expect(h.readReg(h.cpu.pc)).toBe(4);

    h.runInstruction();
    expect(h.readReg(h.cpu.a)).toBe(0x08);
    expect(h.readReg(h.cpu.f)).toBe(F_BIT4_CLEAR);
    expect(h.readReg(h.cpu.pc)).toBe(6);

    h.runInstruction();
    expect(h.readReg(h.cpu.rB.q)).toBe(0x80);

    h.runInstruction();
    expect(h.readReg(h.cpu.rB.q)).toBe(0x80);
    expect(h.readReg(h.cpu.f)).toBe(F_BIT7_SET);
    expect(h.readReg(h.cpu.pc)).toBe(10);
  });

  it('BIT y,(HL) tests a memory bit without writing RAM', () => {
    const PROGRAM = (() => {
      const bytes = new Uint8Array(128);
      bytes.set([0x21, 0x10, 0x00], 0); // LD HL,0x0010
      bytes.set([0xcb, 0x5e], 3); // BIT 3,(HL)
      bytes.set([0xcb, 0x66], 5); // BIT 4,(HL)
      bytes.set([0xcb, 0x7e], 7); // BIT 7,(HL)
      bytes[0x10] = 0x88; // bits 3 and 7 set
      return bytes;
    })();
    const h = makeZ80Harness(PROGRAM);

    h.runInstruction();
    expect(h.readReg(h.cpu.rH.q)).toBe(0);
    expect(h.readReg(h.cpu.rL.q)).toBe(0x10);

    h.runInstruction(); // BIT 3,(HL) — set
    expect(h.cpu.ram.bytes[0x10]).toBe(0x88);
    expect(h.readReg(h.cpu.f)).toBe(F_BIT3_SET);
    expect(h.readReg(h.cpu.pc)).toBe(5);

    h.runInstruction(); // BIT 4,(HL) — clear; X still from mem bit3
    expect(h.cpu.ram.bytes[0x10]).toBe(0x88);
    expect(h.readReg(h.cpu.f)).toBe(F_BIT4_CLEAR);
    expect(h.readReg(h.cpu.pc)).toBe(7);

    h.runInstruction(); // BIT 7,(HL) — set; X from mem bit3=1
    expect(h.cpu.ram.bytes[0x10]).toBe(0x88);
    expect(h.readReg(h.cpu.f)).toBe(F_BIT7_SET_X);
    expect(h.readReg(h.cpu.pc)).toBe(9);
  });
});
