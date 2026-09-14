import { describe, expect, it } from 'vitest';
import { assemble, bytesToHexPrompt } from '../src/machine/assembler.js';

describe('mini assembler', () => {
  it('assembles LD / absolute store / labeled JR', () => {
    const r = assemble(
      `
      LD A,0x41
      LD (0xE00),A
      spin:
      JR spin
      `,
      0x100,
    );
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect([...r.bytes]).toEqual([0x3e, 0x41, 0x32, 0x00, 0x0e, 0x18, 0xfe]);
    expect(r.listing[0]).toContain('0100');
    expect(bytesToHexPrompt(r.bytes)).toBe('3e,41,32,00,0e,18,fe');
  });

  it('assembles char immediates, DB, and CALL label', () => {
    const r = assemble(
      `
      start:
        LD A,'A'
        CALL print
        RET
      print:
        LD (0xE01),A
        RET
        DB "Hi",0
      `,
      0,
    );
    expect(r.ok).toBe(true);
    expect(r.bytes[0]).toBe(0x3e);
    expect(r.bytes[1]).toBe(0x41);
    expect(r.bytes[2]).toBe(0xcd); // CALL
  });

  it('reports unknown mnemonics and bad JR range', () => {
    const bad = assemble('FOO A');
    expect(bad.ok).toBe(false);
    expect(bad.errors.some((e) => /unsupported mnemonic/i.test(e))).toBe(true);

    const far = assemble(
      `
      JR far
      DB 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
      DB 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
      DB 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
      DB 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
      DB 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
      DB 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
      DB 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
      DB 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
      DB 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
      far:
      NOP
      `,
    );
    expect(far.ok).toBe(false);
    expect(far.errors.some((e) => /out of range/i.test(e))).toBe(true);
  });

  it('assembles IX/IY load, stack, and (IX+d) mem', () => {
    const r = assemble(
      `
      LD IX,0x1234
      PUSH IX
      POP IY
      LD A,(IX+2)
      LD (IY-1),B
      LD (IX+0),0x55
      INC (IX+3)
      ADD A,(IY+4)
      ADD IX,BC
      JP (IX)
      `,
    );
    expect(r.errors).toEqual([]);
    expect([...r.bytes]).toEqual([
      0xdd, 0x21, 0x34, 0x12, // LD IX,1234h
      0xdd, 0xe5, // PUSH IX
      0xfd, 0xe1, // POP IY
      0xdd, 0x7e, 0x02, // LD A,(IX+2)
      0xfd, 0x70, 0xff, // LD (IY-1),B
      0xdd, 0x36, 0x00, 0x55, // LD (IX+0),55h
      0xdd, 0x34, 0x03, // INC (IX+3)
      0xfd, 0x86, 0x04, // ADD A,(IY+4)
      0xdd, 0x09, // ADD IX,BC
      0xdd, 0xe9, // JP (IX)
    ]);
  });

  it('assembles IXH remap, CB, DD CB, and ED', () => {
    const r = assemble(
      `
      LD IXH,0xAB
      LD B,IXL
      BIT 7,(HL)
      SET 0,A
      RLC B
      BIT 3,(IX+1)
      RES 2,(IY-2)
      LDIR
      ADC HL,DE
      NEG
      IM 1
      RETI
      `,
    );
    expect(r.errors).toEqual([]);
    expect([...r.bytes]).toEqual([
      0xdd, 0x26, 0xab, // LD IXH,ABh
      0xdd, 0x45, // LD B,IXL
      0xcb, 0x7e, // BIT 7,(HL)
      0xcb, 0xc7, // SET 0,A
      0xcb, 0x00, // RLC B
      0xdd, 0xcb, 0x01, 0x5e, // BIT 3,(IX+1)
      0xfd, 0xcb, 0xfe, 0x96, // RES 2,(IY-2)
      0xed, 0xb0, // LDIR
      0xed, 0x5a, // ADC HL,DE
      0xed, 0x44, // NEG
      0xed, 0x56, // IM 1
      0xed, 0x4d, // RETI
    ]);
  });

  it('assembles SLL r / (HL) / (IX+d)', () => {
    const r = assemble(`
      SLL B
      SLL (HL)
      SLL (IX+2)
    `);
    expect(r.errors).toEqual([]);
    expect([...r.bytes]).toEqual([
      0xcb, 0x30, // SLL B
      0xcb, 0x36, // SLL (HL)
      0xdd, 0xcb, 0x02, 0x36, // SLL (IX+2)
    ]);
  });
});
