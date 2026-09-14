import { describe, expect, it } from 'vitest';
import { makeZ80Harness } from './z80Harness.js';

/**
 * FD/IY — first slice (LD/PUSH/POP) plus HL-clone slice (ADD/INC/DEC/
 * JP/LD SP/EX) plus (IY+d) LD / INC/DEC / ALU A,(IY+d). Prefixed bodies
 * start at PHASE4. See "FD: IY" in ARCHITECTURE.md.
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

describe('buildZ80Cpu — FD: (IY+d) INC/DEC and ALU A,(IY+d)', () => {
  /**
   * Mirror of the DD (IX+d) INC/DEC + ALU program with 0xFD / IY.
   * HL and IX must stay untouched under FD. ADDR_BITS=8; IY=0x0040.
   */
  const ADDR_BITS = 8;
  const HL_H = 0x55;
  const HL_L = 0xaa;
  const IX_H = 0x66;
  const IX_L = 0xbb;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(256);
    bytes.set([0xfd, 0x21, 0x40, 0x00], 0);
    bytes.set([0xfd, 0x36, 0x02, 0x10], 4);
    bytes.set([0xfd, 0x34, 0x02], 8);
    bytes.set([0xfd, 0x35, 0x02], 11);
    bytes.set([0x3e, 0x05], 14);
    bytes.set([0xfd, 0x86, 0x02], 16);
    bytes.set([0xfd, 0xbe, 0x02], 19);
    bytes.set([0xfd, 0x7e, 0x02], 22);
    return bytes;
  })();

  const expectHlIxUntouched = (h: ReturnType<typeof makeZ80Harness>) => {
    expect(h.readReg(h.cpu.rH.q)).toBe(HL_H);
    expect(h.readReg(h.cpu.rL.q)).toBe(HL_L);
    expect(h.readReg(h.cpu.rIXH.q)).toBe(IX_H);
    expect(h.readReg(h.cpu.rIXL.q)).toBe(IX_L);
  };

  it('INC/DEC (IY+d) and ALU A,(IY+d) without clobbering HL or IX', () => {
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
    expect(h.readReg(h.cpu.rIYL.q)).toBe(0x40);
    expectHlIxUntouched(h);

    h.runInstruction(); // LD (IY+2),0x10
    expect(h.cpu.ram.bytes[0x42]).toBe(0x10);
    expectHlIxUntouched(h);

    h.runInstruction(); // INC (IY+2)
    expect(h.cpu.ram.bytes[0x42]).toBe(0x11);
    expect(h.readReg(h.cpu.f) & 0x40).toBe(0);
    expect(h.readReg(h.cpu.f) & 0x02).toBe(0);
    expectHlIxUntouched(h);

    h.runInstruction(); // DEC (IY+2)
    expect(h.cpu.ram.bytes[0x42]).toBe(0x10);
    expect(h.readReg(h.cpu.f) & 0x02).toBe(0x02);
    expectHlIxUntouched(h);

    h.runInstruction(); // LD A,0x05
    expect(h.readReg(h.cpu.a)).toBe(0x05);

    h.runInstruction(); // ADD A,(IY+2)
    expect(h.readReg(h.cpu.a)).toBe(0x15);
    expect(h.cpu.ram.bytes[0x42]).toBe(0x10);
    expectHlIxUntouched(h);

    h.runInstruction(); // CP (IY+2)
    expect(h.readReg(h.cpu.a)).toBe(0x15);
    expect(h.readReg(h.cpu.f) & 0x40).toBe(0);
    expect(h.readReg(h.cpu.f) & 0x02).toBe(0x02);
    expectHlIxUntouched(h);

    h.runInstruction(); // LD A,(IY+2)
    expect(h.readReg(h.cpu.a)).toBe(0x10);
    expectHlIxUntouched(h);
  });
});

describe('buildZ80Cpu — FD CB: BIT y,(IY+d)', () => {
  /**
   * Mirror of DD CB BIT y,(IX+d). ADDR_BITS=8; IY=0x0040; RAM[0x42]=0x88.
   * HL/IX untouched; RAM unchanged.
   */
  const ADDR_BITS = 8;
  const HL_H = 0x55;
  const HL_L = 0xaa;
  const IX_H = 0x66;
  const IX_L = 0xbb;
  const F_BIT3_SET = 0b00011000;
  const F_BIT4_CLEAR = 0b01011100;
  const F_BIT7_SET_X = 0b10011000;

  const PROGRAM = (() => {
    const bytes = new Uint8Array(256);
    bytes.set([0xfd, 0x21, 0x40, 0x00], 0);
    bytes.set([0xfd, 0xcb, 0x02, 0x5e], 4);
    bytes.set([0xfd, 0xcb, 0x02, 0x66], 8);
    bytes.set([0xfd, 0xcb, 0x02, 0x7e], 12);
    bytes[0x42] = 0x88;
    return bytes;
  })();

  const expectHlIxUntouched = (h: ReturnType<typeof makeZ80Harness>) => {
    expect(h.readReg(h.cpu.rH.q)).toBe(HL_H);
    expect(h.readReg(h.cpu.rL.q)).toBe(HL_L);
    expect(h.readReg(h.cpu.rIXH.q)).toBe(IX_H);
    expect(h.readReg(h.cpu.rIXL.q)).toBe(IX_L);
  };

  it('BIT y,(IY+d) tests memory without writing RAM or touching HL/IX', () => {
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
    expect(h.readReg(h.cpu.rIYL.q)).toBe(0x40);
    expectHlIxUntouched(h);

    h.runInstruction(); // BIT 3,(IY+2)
    expect(h.cpu.ram.bytes[0x42]).toBe(0x88);
    expect(h.readReg(h.cpu.f)).toBe(F_BIT3_SET);
    expect(h.readReg(h.cpu.pc)).toBe(8);
    expectHlIxUntouched(h);

    h.runInstruction(); // BIT 4,(IY+2)
    expect(h.cpu.ram.bytes[0x42]).toBe(0x88);
    expect(h.readReg(h.cpu.f)).toBe(F_BIT4_CLEAR);
    expect(h.readReg(h.cpu.pc)).toBe(12);
    expectHlIxUntouched(h);

    h.runInstruction(); // BIT 7,(IY+2)
    expect(h.cpu.ram.bytes[0x42]).toBe(0x88);
    expect(h.readReg(h.cpu.f)).toBe(F_BIT7_SET_X);
    expect(h.readReg(h.cpu.pc)).toBe(16);
    expectHlIxUntouched(h);
  });
});

describe('buildZ80Cpu — FD CB: SET/RES/rot (IY+d)', () => {
  /**
   * Mirror of DD CB SET/RES/RLC (IX+d). ADDR_BITS=8; IY=0x0040.
   * HL/IX untouched.
   */
  const ADDR_BITS = 8;
  const HL_H = 0x55;
  const HL_L = 0xaa;
  const IX_H = 0x66;
  const IX_L = 0xbb;

  function parityEven(n: number): number {
    let p = 0;
    for (let i = 0; i < 8; i++) p ^= (n >> i) & 1;
    return p ^ 1;
  }
  function flagsFromResult(result: number, c: number): number {
    const s = (result >> 7) & 1;
    const z = result === 0 ? 1 : 0;
    const y = (result >> 5) & 1;
    const x = (result >> 3) & 1;
    const p = parityEven(result);
    return (s << 7) | (z << 6) | (y << 5) | (x << 3) | (p << 2) | c;
  }

  const PROGRAM = (() => {
    const bytes = new Uint8Array(256);
    bytes.set([0xfd, 0x21, 0x40, 0x00], 0);
    bytes.set([0xfd, 0xcb, 0x02, 0xde], 4);
    bytes.set([0xfd, 0xcb, 0x02, 0x9e], 8);
    bytes.set([0xfd, 0xcb, 0x02, 0xc6], 12);
    bytes.set([0xfd, 0xcb, 0x02, 0x06], 16);
    bytes[0x42] = 0x00;
    return bytes;
  })();

  const expectHlIxUntouched = (h: ReturnType<typeof makeZ80Harness>) => {
    expect(h.readReg(h.cpu.rH.q)).toBe(HL_H);
    expect(h.readReg(h.cpu.rL.q)).toBe(HL_L);
    expect(h.readReg(h.cpu.rIXH.q)).toBe(IX_H);
    expect(h.readReg(h.cpu.rIXL.q)).toBe(IX_L);
  };

  it('SET/RES/RLC (IY+d) modify memory without touching HL/IX', () => {
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

    const fBefore = h.readReg(h.cpu.f);

    h.runInstruction(); // LD IY,0x0040
    expect(h.readReg(h.cpu.rIYL.q)).toBe(0x40);
    expectHlIxUntouched(h);

    h.runInstruction(); // SET 3,(IY+2)
    expect(h.cpu.ram.bytes[0x42]).toBe(0x08);
    expect(h.readReg(h.cpu.f)).toBe(fBefore);
    expect(h.readReg(h.cpu.pc)).toBe(8);
    expectHlIxUntouched(h);

    h.runInstruction(); // RES 3,(IY+2)
    expect(h.cpu.ram.bytes[0x42]).toBe(0x00);
    expect(h.readReg(h.cpu.f)).toBe(fBefore);
    expect(h.readReg(h.cpu.pc)).toBe(12);
    expectHlIxUntouched(h);

    h.runInstruction(); // SET 0,(IY+2)
    expect(h.cpu.ram.bytes[0x42]).toBe(0x01);
    expect(h.readReg(h.cpu.f)).toBe(fBefore);
    expect(h.readReg(h.cpu.pc)).toBe(16);
    expectHlIxUntouched(h);

    h.runInstruction(); // RLC (IY+2)
    expect(h.cpu.ram.bytes[0x42]).toBe(0x02);
    expect(h.readReg(h.cpu.f)).toBe(flagsFromResult(0x02, 0));
    expect(h.readReg(h.cpu.pc)).toBe(20);
    expectHlIxUntouched(h);
  });
});

describe('buildZ80Cpu — FD: H→IYH / L→IYL 8-bit remap', () => {
  /**
   * FD mirror of DD H→IXH remap. Seed IY=0xAABB, HL=0x1122, B=0; IX/HL
   * must stay untouched under FD.
   */
  const ADDR_BITS = 8;
  const HL_H = 0x11;
  const HL_L = 0x22;
  const IX_H = 0x66;
  const IX_L = 0x77;
  const IY0_H = 0xaa;
  const IY0_L = 0xbb;

  const PROGRAM = (() => {
    const bytes = new Uint8Array(256);
    bytes.set([0xfd, 0x44], 0);
    bytes.set([0xfd, 0x60], 2);
    bytes.set([0xfd, 0x26, 0x99], 4);
    bytes.set([0xfd, 0x2c], 7);
    bytes.set([0xfd, 0x25], 9);
    bytes.set([0xfd, 0x66, 0x02], 11);
    bytes[0xbe] = 0x5a;
    return bytes;
  })();

  const expectHlIxUntouched = (h: ReturnType<typeof makeZ80Harness>) => {
    expect(h.readReg(h.cpu.rH.q)).toBe(HL_H);
    expect(h.readReg(h.cpu.rL.q)).toBe(HL_L);
    expect(h.readReg(h.cpu.rIXH.q)).toBe(IX_H);
    expect(h.readReg(h.cpu.rIXL.q)).toBe(IX_L);
  };

  it('remaps LD/imm/INC/DEC onto IYH/IYL and leaves HL/IX alone', () => {
    const h = makeZ80Harness(PROGRAM, ADDR_BITS, (cpu, seedReg) => {
      seedReg(cpu.rB, 0);
      seedReg(cpu.rC, 0);
      seedReg(cpu.rD, 0);
      seedReg(cpu.rE, 0);
      seedReg(cpu.rH, HL_H);
      seedReg(cpu.rL, HL_L);
      seedReg(cpu.rIXH, IX_H);
      seedReg(cpu.rIXL, IX_L);
      seedReg(cpu.rIYH, IY0_H);
      seedReg(cpu.rIYL, IY0_L);
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

    h.runInstruction(); // LD B,H → B=IYH
    expect(h.readReg(h.cpu.rB.q)).toBe(IY0_H);
    expect(h.readReg(h.cpu.rIYH.q)).toBe(IY0_H);
    expectHlIxUntouched(h);

    h.runInstruction(); // LD H,B → IYH=B
    expect(h.readReg(h.cpu.rIYH.q)).toBe(IY0_H);
    expectHlIxUntouched(h);

    h.runInstruction(); // LD H,n → IYH=0x99
    expect(h.readReg(h.cpu.rIYH.q)).toBe(0x99);
    expectHlIxUntouched(h);

    h.runInstruction(); // INC L → INC IYL
    expect(h.readReg(h.cpu.rIYL.q)).toBe((IY0_L + 1) & 0xff);
    expectHlIxUntouched(h);

    h.runInstruction(); // DEC H → DEC IYH
    expect(h.readReg(h.cpu.rIYH.q)).toBe(0x98);
    expectHlIxUntouched(h);

    const iyhBefore = h.readReg(h.cpu.rIYH.q);
    h.runInstruction(); // LD H,(IY+2) still writes H
    expect(h.readReg(h.cpu.rH.q)).toBe(0x5a);
    expect(h.readReg(h.cpu.rIYH.q)).toBe(iyhBefore);
    expect(h.readReg(h.cpu.rL.q)).toBe(HL_L);
    expect(h.readReg(h.cpu.rIXH.q)).toBe(IX_H);
    expect(h.readReg(h.cpu.rIXL.q)).toBe(IX_L);
  });
});
