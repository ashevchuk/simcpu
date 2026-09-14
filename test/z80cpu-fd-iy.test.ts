import { describe, expect, it } from 'vitest';
import { makeZ80Harness } from './z80Harness.js';

/**
 * FD/IY — first slice (LD/PUSH/POP) plus HL-clone slice (ADD/INC/DEC/
 * JP/LD SP/EX) plus (IY+d) LD. Prefixed bodies start at PHASE4. See
 * "FD: IY" in ARCHITECTURE.md.
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
    expect(h.cpu.ram.bytes[SP0 - 1]).toBe(0x12);
    expect(h.cpu.ram.bytes[SP0 - 2]).toBe(0x34);
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

describe('buildZ80Cpu — FD: HL-clone ops (ADD/INC/DEC/JP/LD SP/EX)', () => {
  /**
   * Mirror of the DD HL-clone program with 0xFD / IY. HL and IX must stay
   * untouched under FD.
   */
  const ADDR_BITS = 7;
  const HL_H = 0x55;
  const HL_L = 0xaa;
  const IX_H = 0x66;
  const IX_L = 0xbb;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0xfd, 0x21, 0x10, 0x00], 0);
    bytes.set([0x01, 0x03, 0x00], 4);
    bytes.set([0xfd, 0x09], 7);
    bytes.set([0xfd, 0x29], 9);
    bytes.set([0xfd, 0x23], 11);
    bytes.set([0xfd, 0x2b], 13);
    bytes.set([0xfd, 0xf9], 15);
    bytes.set([0x31, 0x60, 0x00], 17);
    bytes.set([0xfd, 0x21, 0xaa, 0xbb], 20);
    bytes.set([0xfd, 0xe3], 24);
    bytes.set([0xfd, 0xe3], 26);
    bytes.set([0xfd, 0x21, 0x40, 0x00], 28);
    bytes.set([0xfd, 0xe9], 32);
    bytes.set([0x00], 0x40);
    bytes.set([0x11], 0x60);
    bytes.set([0x22], 0x61);
    return bytes;
  })();

  const expectHlIxUntouched = (h: ReturnType<typeof makeZ80Harness>) => {
    expect(h.readReg(h.cpu.rH.q)).toBe(HL_H);
    expect(h.readReg(h.cpu.rL.q)).toBe(HL_L);
    expect(h.readReg(h.cpu.rIXH.q)).toBe(IX_H);
    expect(h.readReg(h.cpu.rIXL.q)).toBe(IX_L);
  };

  it('runs ADD/INC/DEC/LD SP/EX/JP on IY without clobbering HL or IX', () => {
    const h = makeZ80Harness(PROGRAM, ADDR_BITS, (cpu, seedReg) => {
      seedReg(cpu.rB, 0);
      seedReg(cpu.rC, 0);
      seedReg(cpu.rD, 0);
      seedReg(cpu.rE, 0);
      seedReg(cpu.rH, HL_H);
      seedReg(cpu.rL, HL_L);
      seedReg(cpu.rIXH, IX_H);
      seedReg(cpu.rIXL, IX_L);
      seedReg(cpu.rIYH, 0);
      seedReg(cpu.rIYL, 0);
      seedReg(cpu.sp, 0, ADDR_BITS);
      seedReg(cpu.aP, 0);
      seedReg(cpu.fP, 0);
      seedReg(cpu.bP, 0);
      seedReg(cpu.cP, 0);
      seedReg(cpu.dP, 0);
      seedReg(cpu.eP, 0);
      seedReg(cpu.hP, 0);
      seedReg(cpu.lP, 0);
    });

    h.runInstruction(); // LD IY,0x0010
    expect(h.readReg(h.cpu.rIYH.q)).toBe(0x00);
    expect(h.readReg(h.cpu.rIYL.q)).toBe(0x10);
    expectHlIxUntouched(h);

    h.runInstruction(); // LD BC,0x0003
    expect(h.readReg(h.cpu.rB.q)).toBe(0x00);
    expect(h.readReg(h.cpu.rC.q)).toBe(0x03);

    h.runInstruction(); // ADD IY,BC
    expect(h.readReg(h.cpu.rIYH.q)).toBe(0x00);
    expect(h.readReg(h.cpu.rIYL.q)).toBe(0x13);
    expectHlIxUntouched(h);

    h.runInstruction(); // ADD IY,IY
    expect(h.readReg(h.cpu.rIYH.q)).toBe(0x00);
    expect(h.readReg(h.cpu.rIYL.q)).toBe(0x26);
    expectHlIxUntouched(h);

    h.runInstruction(); // INC IY
    expect(h.readReg(h.cpu.rIYH.q)).toBe(0x00);
    expect(h.readReg(h.cpu.rIYL.q)).toBe(0x27);
    expectHlIxUntouched(h);

    h.runInstruction(); // DEC IY
    expect(h.readReg(h.cpu.rIYH.q)).toBe(0x00);
    expect(h.readReg(h.cpu.rIYL.q)).toBe(0x26);
    expectHlIxUntouched(h);

    h.runInstruction(); // LD SP,IY
    expect(h.readReg(h.cpu.sp.q)).toBe(0x26);
    expectHlIxUntouched(h);

    h.runInstruction(); // LD SP,0x0060
    expect(h.readReg(h.cpu.sp.q)).toBe(0x60);

    h.runInstruction(); // LD IY,0xBBAA
    expect(h.readReg(h.cpu.rIYH.q)).toBe(0xbb);
    expect(h.readReg(h.cpu.rIYL.q)).toBe(0xaa);
    expectHlIxUntouched(h);

    h.runInstruction(); // EX (SP),IY
    expect(h.readReg(h.cpu.rIYH.q)).toBe(0x22);
    expect(h.readReg(h.cpu.rIYL.q)).toBe(0x11);
    expect(h.cpu.ram.bytes[0x60]).toBe(0xaa);
    expect(h.cpu.ram.bytes[0x61]).toBe(0xbb);
    expect(h.readReg(h.cpu.sp.q)).toBe(0x60);
    expectHlIxUntouched(h);

    h.runInstruction(); // EX (SP),IY again
    expect(h.readReg(h.cpu.rIYH.q)).toBe(0xbb);
    expect(h.readReg(h.cpu.rIYL.q)).toBe(0xaa);
    expect(h.cpu.ram.bytes[0x60]).toBe(0x11);
    expect(h.cpu.ram.bytes[0x61]).toBe(0x22);
    expectHlIxUntouched(h);

    h.runInstruction(); // LD IY,0x0040
    expect(h.readReg(h.cpu.rIYH.q)).toBe(0x00);
    expect(h.readReg(h.cpu.rIYL.q)).toBe(0x40);

    h.runInstruction(); // JP (IY)
    expect(h.readReg(h.cpu.pc)).toBe(0x40);
    expectHlIxUntouched(h);

    h.runInstruction(); // NOP at 0x40
    expect(h.readReg(h.cpu.pc)).toBe(0x41);
    expectHlIxUntouched(h);
  });
});

describe('buildZ80Cpu — FD: (IY+d) LD r/(IY+d),r/(IY+d),n', () => {
  /**
   * Mirror of the DD (IX+d) LD program with 0xFD / IY. HL and IX must stay
   * untouched under FD. ADDR_BITS=8; IY=0x0040 so (IY+2) stays past the
   * instruction stream (same self-modify trap as the DD test).
   */
  const ADDR_BITS = 8;
  const HL_H = 0x55;
  const HL_L = 0xaa;
  const IX_H = 0x66;
  const IX_L = 0xbb;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(256);
    bytes.set([0xfd, 0x21, 0x40, 0x00], 0);
    bytes.set([0x3e, 0xaa], 4);
    bytes.set([0xfd, 0x77, 0x02], 6);
    bytes.set([0xaf], 9);
    bytes.set([0xfd, 0x7e, 0x02], 10);
    bytes.set([0xfd, 0x36, 0x02, 0x55], 13);
    bytes.set([0xfd, 0x46, 0x02], 17);
    return bytes;
  })();

  const expectHlIxUntouched = (h: ReturnType<typeof makeZ80Harness>) => {
    expect(h.readReg(h.cpu.rH.q)).toBe(HL_H);
    expect(h.readReg(h.cpu.rL.q)).toBe(HL_L);
    expect(h.readReg(h.cpu.rIXH.q)).toBe(IX_H);
    expect(h.readReg(h.cpu.rIXL.q)).toBe(IX_L);
  };

  it('loads through (IY+d) without clobbering HL or IX', () => {
    const h = makeZ80Harness(PROGRAM, ADDR_BITS, (cpu, seedReg) => {
      seedReg(cpu.rB, 0);
      seedReg(cpu.rC, 0);
      seedReg(cpu.rD, 0);
      seedReg(cpu.rE, 0);
      seedReg(cpu.rH, HL_H);
      seedReg(cpu.rL, HL_L);
      seedReg(cpu.rIXH, IX_H);
      seedReg(cpu.rIXL, IX_L);
      seedReg(cpu.rIYH, 0);
      seedReg(cpu.rIYL, 0);
      seedReg(cpu.sp, 0, ADDR_BITS);
      seedReg(cpu.aP, 0);
      seedReg(cpu.fP, 0);
      seedReg(cpu.bP, 0);
      seedReg(cpu.cP, 0);
      seedReg(cpu.dP, 0);
      seedReg(cpu.eP, 0);
      seedReg(cpu.hP, 0);
      seedReg(cpu.lP, 0);
    });

    h.runInstruction(); // LD IY,0x0040
    expect(h.readReg(h.cpu.rIYH.q)).toBe(0x00);
    expect(h.readReg(h.cpu.rIYL.q)).toBe(0x40);
    expectHlIxUntouched(h);

    h.runInstruction(); // LD A,0xAA
    expect(h.readReg(h.cpu.a)).toBe(0xaa);

    h.runInstruction(); // LD (IY+2),A
    expect(h.cpu.ram.bytes[0x42]).toBe(0xaa);
    expect(h.readReg(h.cpu.rIYL.q)).toBe(0x40);
    expectHlIxUntouched(h);

    h.runInstruction(); // XOR A
    expect(h.readReg(h.cpu.a)).toBe(0);

    h.runInstruction(); // LD A,(IY+2)
    expect(h.readReg(h.cpu.a)).toBe(0xaa);
    expectHlIxUntouched(h);

    h.runInstruction(); // LD (IY+2),0x55
    expect(h.cpu.ram.bytes[0x42]).toBe(0x55);
    expectHlIxUntouched(h);

    h.runInstruction(); // LD B,(IY+2)
    expect(h.readReg(h.cpu.rB.q)).toBe(0x55);
    expect(h.readReg(h.cpu.a)).toBe(0xaa);
    expectHlIxUntouched(h);
  });
});
