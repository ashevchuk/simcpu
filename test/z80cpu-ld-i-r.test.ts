import { describe, expect, it } from 'vitest';
import { makeZ80Harness } from './z80Harness.js';

/**
 * `LD I,A` / `LD R,A` / `LD A,I` / `LD A,R` — see "x=01, z=7, y=0..3" in
 * ARCHITECTURE.md. Round-trip A through I and R; flags on the A← loads
 * (S/Z/X/Y from the byte, H=N=P/V=0, C held). P/V is deliberately 0 —
 * real Z80 copies IFF2, which this project does not model yet.
 *
 * 0:  0x3E,0xA5       LD A,0xA5
 * 2:  0xED,0x47       LD I,A
 * 4:  0x3E,0x00       LD A,0x00
 * 6:  0xED,0x57       LD A,I      A←0xA5; F from 0xA5 with P/V=0
 * 8:  0x3E,0x5A       LD A,0x5A
 * 10: 0xED,0x4F       LD R,A
 * 12: 0x3E,0x00       LD A,0x00
 * 14: 0xED,0x5F       LD A,R      A←0x5A; F from 0x5A with P/V=0
 */
describe('buildZ80Cpu — x=01, z=7, y=0..3: LD I,A / LD R,A / LD A,I / LD A,R', () => {
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0x3e, 0xa5], 0);
    bytes.set([0xed, 0x47], 2);
    bytes.set([0x3e, 0x00], 4);
    bytes.set([0xed, 0x57], 6);
    bytes.set([0x3e, 0x5a], 8);
    bytes.set([0xed, 0x4f], 10);
    bytes.set([0x3e, 0x00], 12);
    bytes.set([0xed, 0x5f], 14);
    return bytes;
  })();

  // 0xA5 = 1010_0101 → S=1,Z=0,Y=1,H=0,X=0,P/V=0,N=0,C=0
  const F_FROM_A5 = 0b10100000;
  // 0x5A = 0101_1010 → S=0,Z=0,Y=0,H=0,X=1,P/V=0,N=0,C=0
  const F_FROM_5A = 0b00001000;

  it('round-trips A through I and R and sets flags on LD A,I/R', () => {
    const h = makeZ80Harness(PROGRAM);

    h.runInstruction(); // LD A,0xA5
    expect(h.readReg(h.cpu.a)).toBe(0xa5);

    h.runInstruction(); // LD I,A
    expect(h.readReg(h.cpu.rI)).toBe(0xa5);
    expect(h.readReg(h.cpu.a)).toBe(0xa5);

    h.runInstruction(); // LD A,0x00
    expect(h.readReg(h.cpu.a)).toBe(0);

    h.runInstruction(); // LD A,I
    expect(h.readReg(h.cpu.a)).toBe(0xa5);
    expect(h.readReg(h.cpu.f)).toBe(F_FROM_A5);
    expect(h.readReg(h.cpu.pc)).toBe(8);

    h.runInstruction(); // LD A,0x5A
    expect(h.readReg(h.cpu.a)).toBe(0x5a);

    h.runInstruction(); // LD R,A
    expect(h.readReg(h.cpu.rR)).toBe(0x5a);

    h.runInstruction(); // LD A,0x00
    expect(h.readReg(h.cpu.a)).toBe(0);

    h.runInstruction(); // LD A,R
    expect(h.readReg(h.cpu.a)).toBe(0x5a);
    expect(h.readReg(h.cpu.f)).toBe(F_FROM_5A);
    expect(h.readReg(h.cpu.rI)).toBe(0xa5); // I untouched by the R path
    expect(h.readReg(h.cpu.pc)).toBe(16);
  });
});
