import { describe, expect, it } from 'vitest';
import { makeZ80Harness } from './z80Harness.js';

/**
 * ED `LD (nn),dd` / `LD dd,(nn)` — see "x=01, z=3: LD (nn),dd" in
 * ARCHITECTURE.md. Absolute 16-bit load/store for BC/DE/HL/SP, fitting
 * into the remaining PHASE4-7 budget after the ED prefix by reading the
 * high immediate byte at PC+1 (no separate advance between the two
 * immediate reads). Round-trip through RAM for each pair: store a known
 * value, clear the pair, load it back.
 *
 *  0: 01 34 12       LD BC,0x1234
 *  3: ED 43 40 00    LD (0x0040),BC
 *  7: 01 00 00       LD BC,0x0000
 * 10: ED 4B 40 00    LD BC,(0x0040)   — BC <- 0x1234
 * 14: 11 78 56       LD DE,0x5678
 * 17: ED 53 50 00    LD (0x0050),DE
 * 21: 11 00 00       LD DE,0x0000
 * 24: ED 5B 50 00    LD DE,(0x0050)   — DE <- 0x5678
 * 28: 21 BC 9A       LD HL,0x9ABC
 * 31: ED 63 60 00    LD (0x0060),HL
 * 35: 21 00 00       LD HL,0x0000
 * 38: ED 6B 60 00    LD HL,(0x0060)   — HL <- 0x9ABC
 * 42: 31 20 00       LD SP,0x0020
 * 45: ED 73 70 00    LD (0x0070),SP
 * 49: 31 00 00       LD SP,0x0000
 * 52: ED 7B 70 00    LD SP,(0x0070)   — SP <- 0x0020
 */
describe('buildZ80Cpu — x=01, z=3: LD (nn),dd / LD dd,(nn)', () => {
  const ADDR_BITS = 7;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0x01, 0x34, 0x12], 0);
    bytes.set([0xed, 0x43, 0x40, 0x00], 3);
    bytes.set([0x01, 0x00, 0x00], 7);
    bytes.set([0xed, 0x4b, 0x40, 0x00], 10);
    bytes.set([0x11, 0x78, 0x56], 14);
    bytes.set([0xed, 0x53, 0x50, 0x00], 17);
    bytes.set([0x11, 0x00, 0x00], 21);
    bytes.set([0xed, 0x5b, 0x50, 0x00], 24);
    bytes.set([0x21, 0xbc, 0x9a], 28);
    bytes.set([0xed, 0x63, 0x60, 0x00], 31);
    bytes.set([0x21, 0x00, 0x00], 35);
    bytes.set([0xed, 0x6b, 0x60, 0x00], 38);
    bytes.set([0x31, 0x20, 0x00], 42);
    bytes.set([0xed, 0x73, 0x70, 0x00], 45);
    bytes.set([0x31, 0x00, 0x00], 49);
    bytes.set([0xed, 0x7b, 0x70, 0x00], 52);
    return bytes;
  })();

  interface Snapshot {
    bc: number;
    de: number;
    hl: number;
    sp: number;
    ram40: number;
    ram50: number;
    ram60: number;
    ram70: number;
    pc: number;
  }

  it('stores and reloads BC/DE/HL/SP through absolute (nn) addresses', () => {
    const h = makeZ80Harness(PROGRAM, ADDR_BITS);
    const snap = (): Snapshot => ({
      bc: (h.readReg(h.cpu.rB.q) << 8) | h.readReg(h.cpu.rC.q),
      de: (h.readReg(h.cpu.rD.q) << 8) | h.readReg(h.cpu.rE.q),
      hl: (h.readReg(h.cpu.rH.q) << 8) | h.readReg(h.cpu.rL.q),
      sp: h.readReg(h.cpu.sp.q),
      ram40: h.cpu.ram.bytes[0x40]! | (h.cpu.ram.bytes[0x41]! << 8),
      ram50: h.cpu.ram.bytes[0x50]! | (h.cpu.ram.bytes[0x51]! << 8),
      ram60: h.cpu.ram.bytes[0x60]! | (h.cpu.ram.bytes[0x61]! << 8),
      ram70: h.cpu.ram.bytes[0x70]! | (h.cpu.ram.bytes[0x71]! << 8),
      pc: h.readReg(h.cpu.pc),
    });

    const expected: Snapshot[] = [
      { bc: 0x1234, de: 0, hl: 0, sp: 0, ram40: 0, ram50: 0, ram60: 0, ram70: 0, pc: 3 },
      { bc: 0x1234, de: 0, hl: 0, sp: 0, ram40: 0x1234, ram50: 0, ram60: 0, ram70: 0, pc: 7 },
      { bc: 0x0000, de: 0, hl: 0, sp: 0, ram40: 0x1234, ram50: 0, ram60: 0, ram70: 0, pc: 10 },
      { bc: 0x1234, de: 0, hl: 0, sp: 0, ram40: 0x1234, ram50: 0, ram60: 0, ram70: 0, pc: 14 },
      { bc: 0x1234, de: 0x5678, hl: 0, sp: 0, ram40: 0x1234, ram50: 0, ram60: 0, ram70: 0, pc: 17 },
      { bc: 0x1234, de: 0x5678, hl: 0, sp: 0, ram40: 0x1234, ram50: 0x5678, ram60: 0, ram70: 0, pc: 21 },
      { bc: 0x1234, de: 0x0000, hl: 0, sp: 0, ram40: 0x1234, ram50: 0x5678, ram60: 0, ram70: 0, pc: 24 },
      { bc: 0x1234, de: 0x5678, hl: 0, sp: 0, ram40: 0x1234, ram50: 0x5678, ram60: 0, ram70: 0, pc: 28 },
      { bc: 0x1234, de: 0x5678, hl: 0x9abc, sp: 0, ram40: 0x1234, ram50: 0x5678, ram60: 0, ram70: 0, pc: 31 },
      { bc: 0x1234, de: 0x5678, hl: 0x9abc, sp: 0, ram40: 0x1234, ram50: 0x5678, ram60: 0x9abc, ram70: 0, pc: 35 },
      { bc: 0x1234, de: 0x5678, hl: 0x0000, sp: 0, ram40: 0x1234, ram50: 0x5678, ram60: 0x9abc, ram70: 0, pc: 38 },
      { bc: 0x1234, de: 0x5678, hl: 0x9abc, sp: 0, ram40: 0x1234, ram50: 0x5678, ram60: 0x9abc, ram70: 0, pc: 42 },
      { bc: 0x1234, de: 0x5678, hl: 0x9abc, sp: 0x20, ram40: 0x1234, ram50: 0x5678, ram60: 0x9abc, ram70: 0, pc: 45 },
      { bc: 0x1234, de: 0x5678, hl: 0x9abc, sp: 0x20, ram40: 0x1234, ram50: 0x5678, ram60: 0x9abc, ram70: 0x20, pc: 49 },
      { bc: 0x1234, de: 0x5678, hl: 0x9abc, sp: 0, ram40: 0x1234, ram50: 0x5678, ram60: 0x9abc, ram70: 0x20, pc: 52 },
      { bc: 0x1234, de: 0x5678, hl: 0x9abc, sp: 0x20, ram40: 0x1234, ram50: 0x5678, ram60: 0x9abc, ram70: 0x20, pc: 56 },
    ];

    for (const step of expected) {
      h.runInstruction();
      expect(snap()).toEqual(step);
    }
  });
});
