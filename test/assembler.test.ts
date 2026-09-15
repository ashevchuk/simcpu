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

  it('resolves EQU / DEFL in immediates and can omit listing', () => {
    const r = assemble(
      `
      EQU FB,0xE00
      CHAR: EQU 0x41
      DEFL PORT,1
      LD A,CHAR
      LD (FB),A
      OUT (PORT),A
      `,
      0x100,
    );
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect([...r.bytes]).toEqual([0x3e, 0x41, 0x32, 0x00, 0x0e, 0xd3, 0x01]);
    expect(r.listing.length).toBeGreaterThan(0);

    const quiet = assemble('LD A,0', 0, { listing: false });
    expect(quiet.ok).toBe(true);
    expect(quiet.listing).toEqual([]);
    expect(bytesToHexPrompt(quiet.bytes, 2)).toBe('3e,00');
  });

  it('evaluates expressions in immediates and EQU (+ - HIGH/LOW)', () => {
    const r = assemble(
      `
      EQU BASE,0x1000
      EQU LO,LOW BASE
      EQU HI,HIGH(BASE)
      EQU NEXT,BASE+1
      LD A,LO
      LD B,HI
      LD C,BASE-0xFF0
      LD HL,NEXT
      LD A,HIGH 0xABCD
      LD A,LOW(0xABCD)
      `,
      0,
    );
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect([...r.bytes]).toEqual([
      0x3e, 0x00, // LD A,LOW BASE
      0x06, 0x10, // LD B,HIGH(BASE)
      0x0e, 0x10, // LD C,BASE-0xFF0 → 0x10
      0x21, 0x01, 0x10, // LD HL,BASE+1
      0x3e, 0xab, // LD A,HIGH 0xABCD
      0x3e, 0xcd, // LD A,LOW(0xABCD)
    ]);
  });

  it('resolves forward label expressions in pass 2', () => {
    const r = assemble(
      `
      LD A,HERE+1
      LD B,LOW(HERE+1)
      HERE:
      NOP
      DW HERE
      DW HERE+1
      `,
      0,
    );
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    // LD A / LD B at 0..3; HERE at 4; HERE+1 = 5
    expect([...r.bytes.slice(0, 5)]).toEqual([0x3e, 0x05, 0x06, 0x05, 0x00]);
    expect([...r.bytes.slice(5, 9)]).toEqual([0x04, 0x00, 0x05, 0x00]);
  });

  it('ORG mid-stream fills gaps with zeros', () => {
    const r = assemble(
      `
      LD A,1
      ORG 0x108
      LD B,2
      `,
      0x100,
    );
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.origin).toBe(0x100);
    expect(r.bytes.length).toBe(0x0a); // 0x100..0x109 (LD B,2 is 2 bytes at 0x108)
    expect([...r.bytes]).toEqual([
      0x3e, 0x01, // at 0x100
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // gap
      0x06, 0x02, // at 0x108
    ]);
    expect(r.listing.some((l) => l.startsWith('0108'))).toBe(true);
  });

  it('ORG can use EQU and labels for later code', () => {
    const r = assemble(
      `
      EQU DEST,0x110
      NOP
      ORG DEST
      there:
      RET
      `,
      0x100,
    );
    expect(r.errors).toEqual([]);
    expect(r.bytes[0]).toBe(0x00);
    expect(r.bytes[0x10]).toBe(0xc9);
    expect(r.bytes.length).toBe(0x11);
  });

  it('INCLUDE splices files via readFile mock', () => {
    const files: Record<string, string> = {
      '/asm/inc.s': 'LD A,0x42\n',
      '/asm/main.s': 'INCLUDE "inc.s"\nRET\n',
    };
    const r = assemble('INCLUDE "main.s"', 0, {
      includeBase: '/asm',
      readFile: (p) => {
        const t = files[p];
        if (t === undefined) throw new Error(`missing ${p}`);
        return t;
      },
    });
    expect(r.errors).toEqual([]);
    expect([...r.bytes]).toEqual([0x3e, 0x42, 0xc9]);
  });

  it('INCLUDE without readFile reports a clear error', () => {
    const r = assemble('INCLUDE "x.s"');
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /readFile/i.test(e))).toBe(true);
  });

  it('MACRO expands with textual arg substitution', () => {
    const r = assemble(
      `
      MACRO LDAB x,y
        LD A,x
        LD B,y
      ENDM
      LDAB 0x11,0x22
      LDAB 'A','B'
      `,
    );
    expect(r.errors).toEqual([]);
    expect([...r.bytes]).toEqual([
      0x3e, 0x11, 0x06, 0x22,
      0x3e, 0x41, 0x06, 0x42,
    ]);
  });

  it('REPT repeats a body n times (literal or EQU)', () => {
    const r = assemble(
      `
      EQU N,3
      REPT N
        NOP
      ENDR
      REPT 2
        LD A,1
      ENDR
      `,
    );
    expect(r.errors).toEqual([]);
    expect([...r.bytes]).toEqual([0x00, 0x00, 0x00, 0x3e, 0x01, 0x3e, 0x01]);
  });

  it('MACRO and REPT can combine', () => {
    const r = assemble(
      `
      MACRO HN
        HALT
        NOP
      ENDM
      REPT 2
        HN
      ENDR
      `,
    );
    expect(r.errors).toEqual([]);
    expect([...r.bytes]).toEqual([0x76, 0x00, 0x76, 0x00]);
  });
});
