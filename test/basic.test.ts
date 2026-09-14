import { describe, expect, it } from 'vitest';
import { compileBasic } from '../src/machine/basic.js';
import { FB_BASE, MACHINE_ADDR_BITS } from '../src/machine/memoryMap.js';
import { createSoftZ80, softRun } from '../src/machine/softZ80.js';

describe('mini BASIC', () => {
  it('compiles a 3-line program and prints to the text FB via softRun', () => {
    const origin = 0x200;
    const bytes = compileBasic(
      `
      10 PRINT "HI"
      20 LET A=33
      30 END
      `,
      origin,
    );
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes[bytes.length - 1]).toBe(0x76); // HALT

    const ram = new Uint8Array(1 << MACHINE_ADDR_BITS);
    ram.set(bytes, origin);
    const cpu = createSoftZ80(0xdff);
    cpu.pc = origin;
    softRun(cpu, ram, 200);

    expect(cpu.halted).toBe(true);
    expect(ram[FB_BASE]).toBe('H'.charCodeAt(0));
    expect(ram[FB_BASE + 1]).toBe('I'.charCodeAt(0));
    expect(ram[0xc00]).toBe(33); // LET A=33
  });

  it('supports GOTO, PRINT var, and var+number', () => {
    const origin = 0x200;
    const bytes = compileBasic(
      `
      10 LET A=64
      20 LET A=A+1
      30 PRINT A
      40 GOTO 60
      50 PRINT "X"
      60 END
      `,
      origin,
    );
    const ram = new Uint8Array(1 << MACHINE_ADDR_BITS);
    ram.set(bytes, origin);
    const cpu = createSoftZ80(0xdff);
    cpu.pc = origin;
    softRun(cpu, ram, 500);

    expect(cpu.halted).toBe(true);
    expect(ram[0xc00]).toBe(65);
    expect(ram[FB_BASE]).toBe(65); // PRINT A → 'A'
    expect(ram[FB_BASE + 1]).toBe(0); // skipped PRINT "X"
  });
});
