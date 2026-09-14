import { describe, expect, it } from 'vitest';
import { makeZ80Harness } from './z80Harness.js';

/**
 * CB `SET`/`RES` — see "CB x=10/x=11: SET/RES" in ARCHITECTURE.md.
 * No flags. Register form commits at PHASE4; (HL) reads at PHASE4 and
 * writes the modified byte at PHASE5.
 */
describe('buildZ80Cpu — CB x=10/x=11: RES/SET', () => {
  it('SET/RES y,r modify a register bit and leave flags alone', () => {
    const PROGRAM = (() => {
      const bytes = new Uint8Array(128);
      bytes.set([0x3e, 0x00], 0); // LD A,0x00
      bytes.set([0xcb, 0xdf], 2); // SET 3,A → 0x08
      bytes.set([0xcb, 0x9f], 4); // RES 3,A → 0x00
      bytes.set([0x06, 0xff], 6); // LD B,0xFF
      bytes.set([0xcb, 0x80], 8); // RES 0,B → 0xFE
      bytes.set([0xcb, 0xc0], 10); // SET 0,B → 0xFF
      return bytes;
    })();
    const h = makeZ80Harness(PROGRAM);

    h.runInstruction();
    expect(h.readReg(h.cpu.a)).toBe(0);
    const f0 = h.readReg(h.cpu.f);

    h.runInstruction(); // SET 3,A
    expect(h.readReg(h.cpu.a)).toBe(0x08);
    expect(h.readReg(h.cpu.f)).toBe(f0);

    h.runInstruction(); // RES 3,A
    expect(h.readReg(h.cpu.a)).toBe(0);
    expect(h.readReg(h.cpu.f)).toBe(f0);
    expect(h.readReg(h.cpu.pc)).toBe(6);

    h.runInstruction(); // LD B,0xFF
    expect(h.readReg(h.cpu.rB.q)).toBe(0xff);

    h.runInstruction(); // RES 0,B
    expect(h.readReg(h.cpu.rB.q)).toBe(0xfe);

    h.runInstruction(); // SET 0,B
    expect(h.readReg(h.cpu.rB.q)).toBe(0xff);
    expect(h.readReg(h.cpu.pc)).toBe(12);
  });

  it('SET/RES y,(HL) modify memory without touching registers or flags', () => {
    const PROGRAM = (() => {
      const bytes = new Uint8Array(128);
      bytes.set([0x21, 0x10, 0x00], 0); // LD HL,0x0010
      bytes.set([0xcb, 0xde], 3); // SET 3,(HL)
      bytes.set([0xcb, 0x9e], 5); // RES 3,(HL)
      bytes.set([0xcb, 0xfe], 7); // SET 7,(HL)
      bytes[0x10] = 0x01;
      return bytes;
    })();
    const h = makeZ80Harness(PROGRAM);

    h.runInstruction();
    expect(h.cpu.ram.bytes[0x10]).toBe(0x01);
    const f0 = h.readReg(h.cpu.f);

    h.runInstruction(); // SET 3,(HL) → 0x09
    expect(h.cpu.ram.bytes[0x10]).toBe(0x09);
    expect(h.readReg(h.cpu.f)).toBe(f0);
    expect(h.readReg(h.cpu.pc)).toBe(5);

    h.runInstruction(); // RES 3,(HL) → 0x01
    expect(h.cpu.ram.bytes[0x10]).toBe(0x01);
    expect(h.readReg(h.cpu.f)).toBe(f0);

    h.runInstruction(); // SET 7,(HL) → 0x81
    expect(h.cpu.ram.bytes[0x10]).toBe(0x81);
    expect(h.readReg(h.cpu.rH.q)).toBe(0);
    expect(h.readReg(h.cpu.rL.q)).toBe(0x10);
    expect(h.readReg(h.cpu.pc)).toBe(9);
  });
});
