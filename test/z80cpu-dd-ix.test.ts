import { describe, expect, it } from 'vitest';
import { makeZ80Harness } from './z80Harness.js';

/**
 * DD/IX — first slice (LD/PUSH/POP) plus HL-clone slice (ADD/INC/DEC/
 * JP/LD SP/EX) plus (IX+d) LD / INC/DEC / ALU A,(IX+d). Prefixed bodies
 * start at PHASE4. See "DD: IX" in ARCHITECTURE.md.
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

    h.runInstruction(); // LD IX,0x1234
    expect(h.readReg(h.cpu.rIXH.q)).toBe(0x12);
    expect(h.readReg(h.cpu.rIXL.q)).toBe(0x34);
    expect(h.readReg(h.cpu.pc)).toBe(4);

    h.runInstruction(); // PUSH IX
    expect(h.readReg(h.cpu.sp.q)).toBe(SP0 - 2);
    expect(h.cpu.ram.bytes[SP0 - 1]).toBe(0x12);
    expect(h.cpu.ram.bytes[SP0 - 2]).toBe(0x34);
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

describe('buildZ80Cpu — DD: HL-clone ops (ADD/INC/DEC/JP/LD SP/EX)', () => {
  /**
   *  0: DD 21 10 00   LD IX,0x0010
   *  4: 01 03 00      LD BC,0x0003
   *  7: DD 09         ADD IX,BC     IX<-0x0013
   *  9: DD 29         ADD IX,IX     IX<-0x0026
   * 11: DD 23         INC IX        IX<-0x0027
   * 13: DD 2B         DEC IX        IX<-0x0026
   * 15: DD F9         LD SP,IX      SP<-0x26
   * 17: 31 60 00      LD SP,0x0060  (EX setup)
   * 20: DD 21 AA BB   LD IX,0xBBAA
   * 24: DD E3         EX (SP),IX
   * 26: DD E3         EX (SP),IX    round-trip
   * 28: DD 21 40 00   LD IX,0x0040
   * 32: DD E9         JP (IX)
   * 64: 00            NOP at target (prove real jump)
   *
   * HL seeded to 0x55AA and IY to 0x66BB — must stay untouched under DD.
   * RAM[0x60]=0x11, RAM[0x61]=0x22 for EX.
   */
  const ADDR_BITS = 7;
  const HL_H = 0x55;
  const HL_L = 0xaa;
  const IY_H = 0x66;
  const IY_L = 0xbb;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0xdd, 0x21, 0x10, 0x00], 0);
    bytes.set([0x01, 0x03, 0x00], 4);
    bytes.set([0xdd, 0x09], 7);
    bytes.set([0xdd, 0x29], 9);
    bytes.set([0xdd, 0x23], 11);
    bytes.set([0xdd, 0x2b], 13);
    bytes.set([0xdd, 0xf9], 15);
    bytes.set([0x31, 0x60, 0x00], 17);
    bytes.set([0xdd, 0x21, 0xaa, 0xbb], 20);
    bytes.set([0xdd, 0xe3], 24);
    bytes.set([0xdd, 0xe3], 26);
    bytes.set([0xdd, 0x21, 0x40, 0x00], 28);
    bytes.set([0xdd, 0xe9], 32);
    bytes.set([0x00], 0x40);
    bytes.set([0x11], 0x60);
    bytes.set([0x22], 0x61);
    return bytes;
  })();

  const expectHlIyUntouched = (h: ReturnType<typeof makeZ80Harness>) => {
    expect(h.readReg(h.cpu.rH.q)).toBe(HL_H);
    expect(h.readReg(h.cpu.rL.q)).toBe(HL_L);
    expect(h.readReg(h.cpu.rIYH.q)).toBe(IY_H);
    expect(h.readReg(h.cpu.rIYL.q)).toBe(IY_L);
  };

  it('runs ADD/INC/DEC/LD SP/EX/JP on IX without clobbering HL or IY', () => {
    const h = makeZ80Harness(PROGRAM, ADDR_BITS, (cpu, seedReg) => {
      seedReg(cpu.rB, 0);
      seedReg(cpu.rC, 0);
      seedReg(cpu.rD, 0);
      seedReg(cpu.rE, 0);
      seedReg(cpu.rH, HL_H);
      seedReg(cpu.rL, HL_L);
      seedReg(cpu.rIXH, 0);
      seedReg(cpu.rIXL, 0);
      seedReg(cpu.rIYH, IY_H);
      seedReg(cpu.rIYL, IY_L);
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

    h.runInstruction(); // LD IX,0x0010
    expect(h.readReg(h.cpu.rIXH.q)).toBe(0x00);
    expect(h.readReg(h.cpu.rIXL.q)).toBe(0x10);
    expectHlIyUntouched(h);

    h.runInstruction(); // LD BC,0x0003
    expect(h.readReg(h.cpu.rB.q)).toBe(0x00);
    expect(h.readReg(h.cpu.rC.q)).toBe(0x03);

    h.runInstruction(); // ADD IX,BC
    expect(h.readReg(h.cpu.rIXH.q)).toBe(0x00);
    expect(h.readReg(h.cpu.rIXL.q)).toBe(0x13);
    expectHlIyUntouched(h);

    h.runInstruction(); // ADD IX,IX
    expect(h.readReg(h.cpu.rIXH.q)).toBe(0x00);
    expect(h.readReg(h.cpu.rIXL.q)).toBe(0x26);
    expectHlIyUntouched(h);

    h.runInstruction(); // INC IX
    expect(h.readReg(h.cpu.rIXH.q)).toBe(0x00);
    expect(h.readReg(h.cpu.rIXL.q)).toBe(0x27);
    expectHlIyUntouched(h);

    h.runInstruction(); // DEC IX
    expect(h.readReg(h.cpu.rIXH.q)).toBe(0x00);
    expect(h.readReg(h.cpu.rIXL.q)).toBe(0x26);
    expectHlIyUntouched(h);

    h.runInstruction(); // LD SP,IX
    expect(h.readReg(h.cpu.sp.q)).toBe(0x26);
    expectHlIyUntouched(h);

    h.runInstruction(); // LD SP,0x0060
    expect(h.readReg(h.cpu.sp.q)).toBe(0x60);

    h.runInstruction(); // LD IX,0xBBAA
    expect(h.readReg(h.cpu.rIXH.q)).toBe(0xbb);
    expect(h.readReg(h.cpu.rIXL.q)).toBe(0xaa);
    expectHlIyUntouched(h);

    h.runInstruction(); // EX (SP),IX
    expect(h.readReg(h.cpu.rIXH.q)).toBe(0x22);
    expect(h.readReg(h.cpu.rIXL.q)).toBe(0x11);
    expect(h.cpu.ram.bytes[0x60]).toBe(0xaa);
    expect(h.cpu.ram.bytes[0x61]).toBe(0xbb);
    expect(h.readReg(h.cpu.sp.q)).toBe(0x60);
    expectHlIyUntouched(h);

    h.runInstruction(); // EX (SP),IX again
    expect(h.readReg(h.cpu.rIXH.q)).toBe(0xbb);
    expect(h.readReg(h.cpu.rIXL.q)).toBe(0xaa);
    expect(h.cpu.ram.bytes[0x60]).toBe(0x11);
    expect(h.cpu.ram.bytes[0x61]).toBe(0x22);
    expectHlIyUntouched(h);

    h.runInstruction(); // LD IX,0x0040
    expect(h.readReg(h.cpu.rIXH.q)).toBe(0x00);
    expect(h.readReg(h.cpu.rIXL.q)).toBe(0x40);

    h.runInstruction(); // JP (IX)
    expect(h.readReg(h.cpu.pc)).toBe(0x40);
    expectHlIyUntouched(h);

    h.runInstruction(); // NOP at 0x40
    expect(h.readReg(h.cpu.pc)).toBe(0x41);
    expectHlIyUntouched(h);
  });
});

describe('buildZ80Cpu — DD: (IX+d) LD r/(IX+d),r/(IX+d),n', () => {
  /**
   *  0: DD 21 40 00   LD IX,0x0040   (target RAM[0x42] — past this program)
   *  4: 3E AA         LD A,0xAA
   *  6: DD 77 02      LD (IX+2),A      ; RAM[0x42]=0xAA
   *  9: AF            XOR A
   * 10: DD 7E 02      LD A,(IX+2)      ; A=0xAA
   * 13: DD 36 02 55   LD (IX+2),0x55
   * 17: DD 46 02      LD B,(IX+2)      ; B=0x55
   *
   * ADDR_BITS=8 so IX+d uses a full low byte. HL and IY must stay untouched.
   * IX base must keep (IX+d) out of the instruction stream (0x12 would
   * overwrite the LD B opcode at PC=18).
   */
  const ADDR_BITS = 8;
  const HL_H = 0x55;
  const HL_L = 0xaa;
  const IY_H = 0x66;
  const IY_L = 0xbb;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(256);
    bytes.set([0xdd, 0x21, 0x40, 0x00], 0);
    bytes.set([0x3e, 0xaa], 4);
    bytes.set([0xdd, 0x77, 0x02], 6);
    bytes.set([0xaf], 9);
    bytes.set([0xdd, 0x7e, 0x02], 10);
    bytes.set([0xdd, 0x36, 0x02, 0x55], 13);
    bytes.set([0xdd, 0x46, 0x02], 17);
    return bytes;
  })();

  const expectHlIyUntouched = (h: ReturnType<typeof makeZ80Harness>) => {
    expect(h.readReg(h.cpu.rH.q)).toBe(HL_H);
    expect(h.readReg(h.cpu.rL.q)).toBe(HL_L);
    expect(h.readReg(h.cpu.rIYH.q)).toBe(IY_H);
    expect(h.readReg(h.cpu.rIYL.q)).toBe(IY_L);
  };

  it('loads through (IX+d) without clobbering HL or IY', () => {
    const h = makeZ80Harness(PROGRAM, ADDR_BITS, (cpu, seedReg) => {
      seedReg(cpu.rB, 0);
      seedReg(cpu.rC, 0);
      seedReg(cpu.rD, 0);
      seedReg(cpu.rE, 0);
      seedReg(cpu.rH, HL_H);
      seedReg(cpu.rL, HL_L);
      seedReg(cpu.rIXH, 0);
      seedReg(cpu.rIXL, 0);
      seedReg(cpu.rIYH, IY_H);
      seedReg(cpu.rIYL, IY_L);
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

    h.runInstruction(); // LD IX,0x0040
    expect(h.readReg(h.cpu.rIXH.q)).toBe(0x00);
    expect(h.readReg(h.cpu.rIXL.q)).toBe(0x40);
    expectHlIyUntouched(h);

    h.runInstruction(); // LD A,0xAA
    expect(h.readReg(h.cpu.a)).toBe(0xaa);

    h.runInstruction(); // LD (IX+2),A
    expect(h.cpu.ram.bytes[0x42]).toBe(0xaa);
    expect(h.readReg(h.cpu.rIXL.q)).toBe(0x40);
    expectHlIyUntouched(h);

    h.runInstruction(); // XOR A
    expect(h.readReg(h.cpu.a)).toBe(0);

    h.runInstruction(); // LD A,(IX+2)
    expect(h.readReg(h.cpu.a)).toBe(0xaa);
    expectHlIyUntouched(h);

    h.runInstruction(); // LD (IX+2),0x55
    expect(h.cpu.ram.bytes[0x42]).toBe(0x55);
    expectHlIyUntouched(h);

    h.runInstruction(); // LD B,(IX+2)
    expect(h.readReg(h.cpu.rB.q)).toBe(0x55);
    expect(h.readReg(h.cpu.a)).toBe(0xaa);
    expectHlIyUntouched(h);
  });
});

describe('buildZ80Cpu — DD: (IX+d) INC/DEC and ALU A,(IX+d)', () => {
  /**
   *  0: DD 21 40 00   LD IX,0x0040
   *  4: DD 36 02 10   LD (IX+2),0x10
   *  8: DD 34 02      INC (IX+2)       ; RAM[0x42]=0x11
   * 11: DD 35 02      DEC (IX+2)       ; RAM[0x42]=0x10
   * 14: 3E 05         LD A,0x05
   * 16: DD 86 02      ADD A,(IX+2)     ; A=0x15
   * 19: DD BE 02      CP (IX+2)        ; A unchanged, Z=0 (0x15≠0x10)
   * 22: DD 7E 02      LD A,(IX+2)      ; A=0x10 — round-trip read-back
   *
   * ADDR_BITS=8; IX=0x0040 keeps (IX+2) past the instruction stream.
   * HL and IY must stay untouched under DD.
   */
  const ADDR_BITS = 8;
  const HL_H = 0x55;
  const HL_L = 0xaa;
  const IY_H = 0x66;
  const IY_L = 0xbb;
  const PROGRAM = (() => {
    const bytes = new Uint8Array(256);
    bytes.set([0xdd, 0x21, 0x40, 0x00], 0);
    bytes.set([0xdd, 0x36, 0x02, 0x10], 4);
    bytes.set([0xdd, 0x34, 0x02], 8);
    bytes.set([0xdd, 0x35, 0x02], 11);
    bytes.set([0x3e, 0x05], 14);
    bytes.set([0xdd, 0x86, 0x02], 16);
    bytes.set([0xdd, 0xbe, 0x02], 19);
    bytes.set([0xdd, 0x7e, 0x02], 22);
    return bytes;
  })();

  const expectHlIyUntouched = (h: ReturnType<typeof makeZ80Harness>) => {
    expect(h.readReg(h.cpu.rH.q)).toBe(HL_H);
    expect(h.readReg(h.cpu.rL.q)).toBe(HL_L);
    expect(h.readReg(h.cpu.rIYH.q)).toBe(IY_H);
    expect(h.readReg(h.cpu.rIYL.q)).toBe(IY_L);
  };

  it('INC/DEC (IX+d) and ALU A,(IX+d) without clobbering HL or IY', () => {
    const h = makeZ80Harness(PROGRAM, ADDR_BITS, (cpu, seedReg) => {
      seedReg(cpu.rB, 0);
      seedReg(cpu.rC, 0);
      seedReg(cpu.rD, 0);
      seedReg(cpu.rE, 0);
      seedReg(cpu.rH, HL_H);
      seedReg(cpu.rL, HL_L);
      seedReg(cpu.rIXH, 0);
      seedReg(cpu.rIXL, 0);
      seedReg(cpu.rIYH, IY_H);
      seedReg(cpu.rIYL, IY_L);
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

    h.runInstruction(); // LD IX,0x0040
    expect(h.readReg(h.cpu.rIXL.q)).toBe(0x40);
    expectHlIyUntouched(h);

    h.runInstruction(); // LD (IX+2),0x10
    expect(h.cpu.ram.bytes[0x42]).toBe(0x10);
    expectHlIyUntouched(h);

    h.runInstruction(); // INC (IX+2)
    expect(h.cpu.ram.bytes[0x42]).toBe(0x11);
    expect(h.readReg(h.cpu.f) & 0x40).toBe(0); // Z=0
    expect(h.readReg(h.cpu.f) & 0x02).toBe(0); // N=0
    expectHlIyUntouched(h);

    h.runInstruction(); // DEC (IX+2)
    expect(h.cpu.ram.bytes[0x42]).toBe(0x10);
    expect(h.readReg(h.cpu.f) & 0x02).toBe(0x02); // N=1
    expectHlIyUntouched(h);

    h.runInstruction(); // LD A,0x05
    expect(h.readReg(h.cpu.a)).toBe(0x05);

    h.runInstruction(); // ADD A,(IX+2)
    expect(h.readReg(h.cpu.a)).toBe(0x15);
    expect(h.cpu.ram.bytes[0x42]).toBe(0x10);
    expectHlIyUntouched(h);

    h.runInstruction(); // CP (IX+2)
    expect(h.readReg(h.cpu.a)).toBe(0x15); // CP does not write A
    expect(h.readReg(h.cpu.f) & 0x40).toBe(0); // Z=0 (unequal)
    expect(h.readReg(h.cpu.f) & 0x02).toBe(0x02); // N=1
    expectHlIyUntouched(h);

    h.runInstruction(); // LD A,(IX+2)
    expect(h.readReg(h.cpu.a)).toBe(0x10);
    expectHlIyUntouched(h);
  });
});

describe('buildZ80Cpu — DD CB: BIT y,(IX+d)', () => {
  /**
   *  0: DD 21 40 00   LD IX,0x0040
   *  4: DD CB 02 5E   BIT 3,(IX+2)   ; bit 3 of 0x88 set → Z clear
   *  8: DD CB 02 66   BIT 4,(IX+2)   ; bit 4 clear → Z set
   * 12: DD CB 02 7E   BIT 7,(IX+2)   ; bit 7 set → S set, Z clear
   *
   * ADDR_BITS=8; seed RAM[0x42]=0x88. HL/IY untouched; RAM unchanged.
   */
  const ADDR_BITS = 8;
  const HL_H = 0x55;
  const HL_L = 0xaa;
  const IY_H = 0x66;
  const IY_L = 0xbb;
  // F: S Z Y H X P N C — same expectations as z80cpu-bit.test.ts for 0x88
  const F_BIT3_SET = 0b00011000;
  const F_BIT4_CLEAR = 0b01011100;
  const F_BIT7_SET_X = 0b10011000;

  const PROGRAM = (() => {
    const bytes = new Uint8Array(256);
    bytes.set([0xdd, 0x21, 0x40, 0x00], 0);
    bytes.set([0xdd, 0xcb, 0x02, 0x5e], 4);
    bytes.set([0xdd, 0xcb, 0x02, 0x66], 8);
    bytes.set([0xdd, 0xcb, 0x02, 0x7e], 12);
    bytes[0x42] = 0x88;
    return bytes;
  })();

  const expectHlIyUntouched = (h: ReturnType<typeof makeZ80Harness>) => {
    expect(h.readReg(h.cpu.rH.q)).toBe(HL_H);
    expect(h.readReg(h.cpu.rL.q)).toBe(HL_L);
    expect(h.readReg(h.cpu.rIYH.q)).toBe(IY_H);
    expect(h.readReg(h.cpu.rIYL.q)).toBe(IY_L);
  };

  it('BIT y,(IX+d) tests memory without writing RAM or touching HL/IY', () => {
    const h = makeZ80Harness(PROGRAM, ADDR_BITS, (cpu, seedReg) => {
      seedReg(cpu.rB, 0);
      seedReg(cpu.rC, 0);
      seedReg(cpu.rD, 0);
      seedReg(cpu.rE, 0);
      seedReg(cpu.rH, HL_H);
      seedReg(cpu.rL, HL_L);
      seedReg(cpu.rIXH, 0);
      seedReg(cpu.rIXL, 0);
      seedReg(cpu.rIYH, IY_H);
      seedReg(cpu.rIYL, IY_L);
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

    h.runInstruction(); // LD IX,0x0040
    expect(h.readReg(h.cpu.rIXL.q)).toBe(0x40);
    expectHlIyUntouched(h);

    h.runInstruction(); // BIT 3,(IX+2)
    expect(h.cpu.ram.bytes[0x42]).toBe(0x88);
    expect(h.readReg(h.cpu.f)).toBe(F_BIT3_SET);
    expect(h.readReg(h.cpu.pc)).toBe(8);
    expectHlIyUntouched(h);

    h.runInstruction(); // BIT 4,(IX+2)
    expect(h.cpu.ram.bytes[0x42]).toBe(0x88);
    expect(h.readReg(h.cpu.f)).toBe(F_BIT4_CLEAR);
    expect(h.readReg(h.cpu.pc)).toBe(12);
    expectHlIyUntouched(h);

    h.runInstruction(); // BIT 7,(IX+2)
    expect(h.cpu.ram.bytes[0x42]).toBe(0x88);
    expect(h.readReg(h.cpu.f)).toBe(F_BIT7_SET_X);
    expect(h.readReg(h.cpu.pc)).toBe(16);
    expectHlIyUntouched(h);
  });
});
