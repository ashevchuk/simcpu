import { describe, expect, it } from 'vitest';
import { FB_BASE, KEY_DATA, KEY_STATUS, MACHINE_ADDR_BITS } from '../src/machine/memoryMap.js';
import { injectKey } from '../src/machine/tty.js';
import { makeZ80Harness } from './z80Harness.js';

describe('memory-mapped TTY over RamComponent', () => {
  /**
   * Soft devices live in ordinary RAM windows — ordinary LD (nn),A /
   * LD A,(nn) drive them. Keyboard v1 is plain bytes (UI injects; CPU clears).
   *
   *  0: 3E 48        LD A,'H'
   *  2: 32 00 0E     LD (0xE00),A
   *  5: 3A 01 0F     LD A,(KEY_DATA)
   *  8: 32 01 0E     LD (0xE01),A
   * 11: 3E 00        LD A,0
   * 13: 32 00 0F     LD (KEY_STATUS),A
   */
  it('writes the framebuffer and polls/clears soft keyboard registers', () => {
    const program = new Uint8Array(1 << MACHINE_ADDR_BITS);
    program.set([0x3e, 0x48], 0);
    program.set([0x32, 0x00, 0x0e], 2);
    program.set([0x3a, 0x01, 0x0f], 5);
    program.set([0x32, 0x01, 0x0e], 8);
    program.set([0x3e, 0x00], 11);
    program.set([0x32, 0x00, 0x0f], 13);

    const { cpu, runInstruction } = makeZ80Harness(program, MACHINE_ADDR_BITS);
    expect(cpu.ram.bytes.length).toBe(1 << MACHINE_ADDR_BITS);

    injectKey(cpu.ram.bytes, '!'.charCodeAt(0));
    expect(cpu.ram.bytes[KEY_STATUS]).toBe(1);
    expect(cpu.ram.bytes[KEY_DATA]).toBe(0x21);

    runInstruction(); // LD A,'H'
    runInstruction(); // LD (0xE00),A
    expect(cpu.ram.bytes[FB_BASE]).toBe(0x48);

    runInstruction(); // LD A,(KEY_DATA)
    runInstruction(); // LD (0xE01),A
    expect(cpu.ram.bytes[FB_BASE + 1]).toBe(0x21);
    // Gate clear-on-read: KEY_STATUS cleared when KEY_DATA was OE-read.
    expect(cpu.ram.bytes[KEY_STATUS]).toBe(0);

    runInstruction(); // LD A,0
    runInstruction(); // LD (KEY_STATUS),A
    expect(cpu.ram.bytes[KEY_STATUS]).toBe(0);
    expect(cpu.ram.bytes[KEY_DATA]).toBe(0x21); // data left until next inject
  });
});
