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
});
