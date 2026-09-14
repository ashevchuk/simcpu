import { describe, expect, it } from 'vitest';
import { FB_BASE, KEY_STATUS, MACHINE_ADDR_BITS } from '../src/machine/memoryMap.js';
import {
  COMMAND_ROM_BYTES,
  COMMAND_ROM_SOURCE,
  commandRomHexPrompt,
  loadCommandRom,
} from '../src/machine/commandRom.js';
import { assemble } from '../src/machine/assembler.js';
import { injectKey } from '../src/machine/tty.js';
import { makeZ80Harness } from './z80Harness.js';

describe('command ROM image', () => {
  it('assembles under the line-buffer and starts with LD SP', () => {
    const r = assemble(COMMAND_ROM_SOURCE, 0);
    expect(r.errors).toEqual([]);
    expect(r.bytes.length).toBe(COMMAND_ROM_BYTES.length);
    expect(COMMAND_ROM_BYTES.length).toBeGreaterThan(200);
    expect(COMMAND_ROM_BYTES.length).toBeLessThan(0xd00);
    expect(COMMAND_ROM_BYTES[0]).toBe(0x31); // LD SP,nn
    expect(commandRomHexPrompt().startsWith('31,')).toBe(true);

    // Help + KEY_* absolute refs present in the image
    const text = String.fromCharCode(...COMMAND_ROM_BYTES);
    expect(text).toContain('H M addr');
    const hasStatus = [...COMMAND_ROM_BYTES.keys()].some(
      (i) =>
        COMMAND_ROM_BYTES[i] === 0x3a &&
        COMMAND_ROM_BYTES[i + 1] === 0x00 &&
        COMMAND_ROM_BYTES[i + 2] === 0x0f,
    );
    expect(hasStatus).toBe(true);

    const ram = new Uint8Array(4096);
    ram.fill(0xff);
    loadCommandRom(ram);
    expect(ram.subarray(0, COMMAND_ROM_BYTES.length)).toEqual(COMMAND_ROM_BYTES);
  });
});

describe('command ROM on Z80', () => {
  it('prints the prompt and echoes a key into the framebuffer', () => {
    const program = new Uint8Array(1 << MACHINE_ADDR_BITS);
    loadCommandRom(program);

    const { cpu, runInstruction } = makeZ80Harness(program, MACHINE_ADDR_BITS);
    injectKey(cpu.ram.bytes, 'A'.charCodeAt(0));

    // Cold start (SP + prompt CALL) + one echoed char — pad like machine-monitor.
    for (let i = 0; i < 120; i++) runInstruction();

    expect(cpu.ram.bytes[FB_BASE]).toBe('>'.charCodeAt(0));
    expect(cpu.ram.bytes[FB_BASE + 1]).toBe(' '.charCodeAt(0));
    expect(cpu.ram.bytes[FB_BASE + 2]).toBe('A'.charCodeAt(0));
    expect(cpu.ram.bytes[KEY_STATUS]).toBe(0);
  });
});
