import { describe, expect, it } from 'vitest';
import { FB_BASE, KEY_STATUS, MACHINE_ADDR_BITS } from '../src/machine/memoryMap.js';
import { loadCommandRom } from '../src/machine/commandRom.js';
import { createSoftZ80, softRun, softStep } from '../src/machine/softZ80.js';
import { injectKey } from '../src/machine/tty.js';

describe('softZ80', () => {
  it('runs command ROM: prompt, H, help text on FB', () => {
    const ram = new Uint8Array(1 << MACHINE_ADDR_BITS);
    loadCommandRom(ram);
    const cpu = createSoftZ80(0xdff);

    softRun(cpu, ram, 500);
    expect(ram[FB_BASE]).toBe('>'.charCodeAt(0));
    expect(ram[FB_BASE + 1]).toBe(' '.charCodeAt(0));

    injectKey(ram, 'H'.charCodeAt(0));
    softRun(cpu, ram, 2000);
    expect(ram[FB_BASE + 2]).toBe('H'.charCodeAt(0));
    expect(ram[KEY_STATUS]).toBe(0);

    injectKey(ram, 0x0d);
    softRun(cpu, ram, 5000);
    const row1 = String.fromCharCode(...ram.subarray(FB_BASE + 32, FB_BASE + 64));
    expect(row1).toContain('H M');
  });

  it('LD A,n / ADD / JR loop', () => {
    const ram = new Uint8Array(256);
    // LD A,2 / ADD A,3 / HALT
    ram.set([0x3e, 0x02, 0xc6, 0x03, 0x76]);
    const cpu = createSoftZ80(0xff);
    softStep(cpu, ram);
    softStep(cpu, ram);
    expect(cpu.a).toBe(5);
  });
});
