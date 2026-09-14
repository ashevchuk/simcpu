import { describe, expect, it } from 'vitest';
import { makeZ80Harness } from './z80Harness.js';

/**
 * CB x=00 rotate/shift — see "CB x=00: RLC…SRL" in ARCHITECTURE.md.
 * Unlike RLCA/RRCA/RLA/RRA, these refresh S/Z/P/X/Y/H/N/C from the result.
 *
 * Flag layout: C=0 N=1 P=2 X=3 H=4 Y=5 Z=6 S=7.
 */
function parityEven(n: number): number {
  let p = 0;
  for (let i = 0; i < 8; i++) p ^= (n >> i) & 1;
  return p ^ 1;
}

function flagsFromResult(result: number, c: number): number {
  const s = (result >> 7) & 1;
  const z = result === 0 ? 1 : 0;
  const y = (result >> 5) & 1;
  const h = 0;
  const x = (result >> 3) & 1;
  const p = parityEven(result);
  const n = 0;
  return (s << 7) | (z << 6) | (y << 5) | (h << 4) | (x << 3) | (p << 2) | (n << 1) | c;
}

describe('buildZ80Cpu — CB x=00: RLC…SRL', () => {
  it('register form rotates/shifts and refreshes all flags', () => {
    const PROGRAM = (() => {
      const bytes = new Uint8Array(128);
      // LD A,0x55 ; RLC A → 0xAA, C←0
      bytes.set([0x3e, 0x55], 0);
      bytes.set([0xcb, 0x07], 2); // RLC A
      // SCF ; RL A on 0xAA with C=1 → 0x55, C←1
      bytes.set([0x37], 4);
      bytes.set([0xcb, 0x17], 5); // RL A
      // LD B,0x80 ; SRL B → 0x40, C←0 ; SLL B → 0x81, C←0
      bytes.set([0x06, 0x80], 7);
      bytes.set([0xcb, 0x38], 9); // SRL B
      bytes.set([0xcb, 0x30], 11); // SLL B (undocumented bit0=1)
      // LD C,0x81 ; SRA C → 0xC0, C←1
      bytes.set([0x0e, 0x81], 13);
      bytes.set([0xcb, 0x29], 15); // SRA C
      return bytes;
    })();
    const h = makeZ80Harness(PROGRAM);

    h.runInstruction(); // LD A,0x55
    expect(h.readReg(h.cpu.a)).toBe(0x55);

    h.runInstruction(); // RLC A
    expect(h.readReg(h.cpu.a)).toBe(0xaa);
    expect(h.readReg(h.cpu.f)).toBe(flagsFromResult(0xaa, 0));
    expect(h.readReg(h.cpu.pc)).toBe(4);

    h.runInstruction(); // SCF — only C/N; leave S/Z stale from RLC
    expect(h.readReg(h.cpu.a)).toBe(0xaa);

    h.runInstruction(); // RL A (old C=1 into bit0)
    expect(h.readReg(h.cpu.a)).toBe(0x55);
    expect(h.readReg(h.cpu.f)).toBe(flagsFromResult(0x55, 1));

    h.runInstruction(); // LD B,0x80
    expect(h.readReg(h.cpu.rB.q)).toBe(0x80);

    h.runInstruction(); // SRL B
    expect(h.readReg(h.cpu.rB.q)).toBe(0x40);
    expect(h.readReg(h.cpu.f)).toBe(flagsFromResult(0x40, 0));

    h.runInstruction(); // SLL B
    expect(h.readReg(h.cpu.rB.q)).toBe(0x81);
    expect(h.readReg(h.cpu.f)).toBe(flagsFromResult(0x81, 0));

    h.runInstruction(); // LD C,0x81
    expect(h.readReg(h.cpu.rC.q)).toBe(0x81);

    h.runInstruction(); // SRA C
    expect(h.readReg(h.cpu.rC.q)).toBe(0xc0);
    expect(h.readReg(h.cpu.f)).toBe(flagsFromResult(0xc0, 1));
    expect(h.readReg(h.cpu.pc)).toBe(17);
  });

  it('(HL) form rotates memory and refreshes flags', () => {
    const PROGRAM = (() => {
      const bytes = new Uint8Array(128);
      bytes.set([0x21, 0x10, 0x00], 0); // LD HL,0x0010
      bytes.set([0xcb, 0x06], 3); // RLC (HL)
      bytes.set([0xcb, 0x3e], 5); // SRL (HL)
      bytes[0x10] = 0x01;
      return bytes;
    })();
    const h = makeZ80Harness(PROGRAM);

    h.runInstruction(); // LD HL
    expect(h.readReg(h.cpu.rH.q)).toBe(0);
    expect(h.readReg(h.cpu.rL.q)).toBe(0x10);
    expect(h.cpu.ram.bytes[0x10]).toBe(0x01);

    h.runInstruction(); // RLC (HL) → 0x02, C=0
    expect(h.cpu.ram.bytes[0x10]).toBe(0x02);
    expect(h.readReg(h.cpu.f)).toBe(flagsFromResult(0x02, 0));
    expect(h.readReg(h.cpu.pc)).toBe(5);

    h.runInstruction(); // SRL (HL) → 0x01, C=0
    expect(h.cpu.ram.bytes[0x10]).toBe(0x01);
    expect(h.readReg(h.cpu.f)).toBe(flagsFromResult(0x01, 0));
    expect(h.readReg(h.cpu.rH.q)).toBe(0);
    expect(h.readReg(h.cpu.rL.q)).toBe(0x10);
    expect(h.readReg(h.cpu.pc)).toBe(7);
  });
});
