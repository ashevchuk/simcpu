import { describe, expect, it } from 'vitest';
import { compileBasic } from '../src/machine/basic.js';
import { FB_BASE, KEY_DATA, KEY_STATUS, MACHINE_ADDR_BITS } from '../src/machine/memoryMap.js';
import { createSoftZ80, softRun } from '../src/machine/softZ80.js';
import { injectKey } from '../src/machine/tty.js';

function runBasic(source: string, maxOps = 2000, origin = 0x200) {
  const bytes = compileBasic(source, origin);
  const ram = new Uint8Array(1 << MACHINE_ADDR_BITS);
  ram.set(bytes, origin);
  const cpu = createSoftZ80(0xdff);
  cpu.pc = origin;
  softRun(cpu, ram, maxOps, { clearOnReadKeys: true });
  return { bytes, ram, cpu };
}

describe('mini BASIC', () => {
  it('compiles a 3-line program and prints to the text FB via softRun', () => {
    const { ram, cpu, bytes } = runBasic(`
      10 PRINT "HI"
      20 LET A=33
      30 END
    `);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes[bytes.length - 1]).toBe(0x76);
    expect(cpu.halted).toBe(true);
    expect(ram[FB_BASE]).toBe('H'.charCodeAt(0));
    expect(ram[FB_BASE + 1]).toBe('I'.charCodeAt(0));
    expect(ram[0xc00]).toBe(33);
  });

  it('supports GOTO, PRINT var, and var+number', () => {
    const { ram, cpu } = runBasic(`
      10 LET A=64
      20 LET A=A+1
      30 PRINT A
      40 GOTO 60
      50 PRINT "X"
      60 END
    `);
    expect(cpu.halted).toBe(true);
    expect(ram[0xc00]).toBe(65);
    expect(ram[FB_BASE]).toBe(65);
    expect(ram[FB_BASE + 1]).toBe(0);
  });

  it('supports REM, IF THEN, and multi-item PRINT', () => {
    const { ram, cpu } = runBasic(`
      10 REM skip me
      20 LET A=5
      30 IF A=5 THEN 50
      40 PRINT "NO"
      50 PRINT "A";A
      60 PRINT "B",A
      70 END
    `);
    expect(cpu.halted).toBe(true);
    // Skipped PRINT "NO" still reserved two FB cells at compile time.
    expect(ram[FB_BASE]).toBe(0);
    expect(ram[FB_BASE + 1]).toBe(0);
    expect(ram[FB_BASE + 2]).toBe('A'.charCodeAt(0));
    expect(ram[FB_BASE + 3]).toBe(5);
    expect(ram[FB_BASE + 4]).toBe('B'.charCodeAt(0));
    expect(ram[FB_BASE + 5]).toBe(0x20); // comma → space
    expect(ram[FB_BASE + 6]).toBe(5);
  });

  it('supports IF comparisons <> < >', () => {
    const { ram, cpu } = runBasic(`
      10 LET A=3
      20 IF A<>2 THEN 40
      30 PRINT "X"
      40 IF A>2 THEN 60
      50 PRINT "Y"
      60 IF A<9 THEN 80
      70 PRINT "Z"
      80 PRINT "OK"
      90 END
    `);
    expect(cpu.halted).toBe(true);
    // Skipped PRINT "X"/"Y"/"Z" each reserved one cell.
    expect(ram[FB_BASE + 3]).toBe('O'.charCodeAt(0));
    expect(ram[FB_BASE + 4]).toBe('K'.charCodeAt(0));
  });

  it('supports FOR / NEXT loops', () => {
    const { ram, cpu } = runBasic(
      `
      10 LET A=0
      20 FOR I=1 TO 3
      30 LET A=A+1
      40 NEXT I
      50 PRINT A
      60 END
      `,
      5000,
    );
    expect(cpu.halted).toBe(true);
    expect(ram[0xc00]).toBe(3);
    expect(ram[FB_BASE]).toBe(3);
    expect(ram[0xc00 + ('I'.charCodeAt(0) - 65)]).toBe(3);
  });

  it('supports INPUT via KEY_STATUS / KEY_DATA busy-wait', () => {
    const origin = 0x200;
    const bytes = compileBasic(
      `
      10 INPUT A
      20 PRINT A
      30 END
      `,
      origin,
    );
    const ram = new Uint8Array(1 << MACHINE_ADDR_BITS);
    ram.set(bytes, origin);
    const cpu = createSoftZ80(0xdff);
    cpu.pc = origin;
    // Spin until the wait loop is live, then inject
    softRun(cpu, ram, 20, { clearOnReadKeys: true });
    expect(cpu.halted).toBe(false);
    injectKey(ram, 0x41);
    softRun(cpu, ram, 200, { clearOnReadKeys: true });
    expect(cpu.halted).toBe(true);
    expect(ram[0xc00]).toBe(0x41);
    expect(ram[FB_BASE]).toBe(0x41);
    expect(ram[KEY_STATUS]).toBe(0);
    expect(ram[KEY_DATA]).toBe(0x41);
  });
});
