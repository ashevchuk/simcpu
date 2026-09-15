import { describe, expect, it } from 'vitest';
import { FB_BASE, KEY_STATUS, MACHINE_ADDR_BITS } from '../src/machine/memoryMap.js';
import { loadMonitor } from '../src/machine/monitor.js';
import { injectKey } from '../src/machine/tty.js';
import { makeZ80Harness } from './z80Harness.js';

describe('soft echo monitor on Z80', () => {
  it('writes the prompt, echoes a key into the framebuffer, and clears KEY_STATUS', () => {
    const program = new Uint8Array(1 << MACHINE_ADDR_BITS);
    loadMonitor(program);

    const { cpu, runInstruction } = makeZ80Harness(program, MACHINE_ADDR_BITS);
    injectKey(cpu.ram.bytes, 'A'.charCodeAt(0));

    // Init + poll + echo path is under ~20 instructions; pad for JR fall-throughs.
    for (let i = 0; i < 40; i++) runInstruction();

    expect(cpu.ram.bytes[FB_BASE]).toBe('>'.charCodeAt(0));
    expect(cpu.ram.bytes[FB_BASE + 1]).toBe('A'.charCodeAt(0));
    expect(cpu.ram.bytes[KEY_STATUS]).toBe(0);
  });
});
