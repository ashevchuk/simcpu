import { describe, expect, it } from 'vitest';
import { FB_BASE, KEY_DATA, KEY_STATUS, MACHINE_ADDR_BITS } from '../src/machine/memoryMap.js';
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

  it('CB: SET / BIT / RLC', () => {
    const ram = new Uint8Array(256);
    // LD A,0x01 / SET 7,A / BIT 7,A / RLC A / HALT
    ram.set([0x3e, 0x01, 0xcb, 0xff, 0xcb, 0x7f, 0xcb, 0x07, 0x76]);
    const cpu = createSoftZ80(0xff);
    softStep(cpu, ram); // LD A,1
    softStep(cpu, ram); // SET 7,A → 0x81
    expect(cpu.a).toBe(0x81);
    softStep(cpu, ram); // BIT 7,A
    expect(cpu.f & 0x40).toBe(0); // Z clear
    expect(cpu.f & 0x10).toBe(0x10); // H set
    softStep(cpu, ram); // RLC A → 0x03, C=1
    expect(cpu.a).toBe(0x03);
    expect(cpu.f & 0x01).toBe(0x01);
  });

  it('ED: LDIR', () => {
    const ram = new Uint8Array(256);
    ram[0x40] = 0xaa;
    ram[0x41] = 0xbb;
    ram[0x42] = 0xcc;
    // LD HL,0x40 / LD DE,0x80 / LD BC,3 / LDIR / HALT
    ram.set([0x21, 0x40, 0x00, 0x11, 0x80, 0x00, 0x01, 0x03, 0x00, 0xed, 0xb0, 0x76]);
    const cpu = createSoftZ80(0xff);
    softRun(cpu, ram, 20);
    expect(ram[0x80]).toBe(0xaa);
    expect(ram[0x81]).toBe(0xbb);
    expect(ram[0x82]).toBe(0xcc);
    expect(cpu.b).toBe(0);
    expect(cpu.c).toBe(0);
    expect((cpu.h << 8) | cpu.l).toBe(0x43);
    expect((cpu.d << 8) | cpu.e).toBe(0x83);
  });

  it('DD: LD IX,nn / LD A,(IX+d)', () => {
    const ram = new Uint8Array(256);
    ram[0x55] = 0x42;
    // LD IX,0x50 / LD A,(IX+5) / HALT
    ram.set([0xdd, 0x21, 0x50, 0x00, 0xdd, 0x7e, 0x05, 0x76]);
    const cpu = createSoftZ80(0xff);
    softStep(cpu, ram);
    expect(cpu.ix).toBe(0x50);
    softStep(cpu, ram);
    expect(cpu.a).toBe(0x42);
  });

  it('clear-on-read KEY_DATA via soft mem hooks', () => {
    const ram = new Uint8Array(1 << MACHINE_ADDR_BITS);
    injectKey(ram, 'Q'.charCodeAt(0));
    expect(ram[KEY_STATUS]).toBe(1);
    expect(ram[KEY_DATA]).toBe(0x51);
    // LD A,(KEY_DATA) / HALT
    ram[0] = 0x3a;
    ram[1] = KEY_DATA & 0xff;
    ram[2] = KEY_DATA >> 8;
    ram[3] = 0x76;
    const cpu = createSoftZ80(0xdff);
    softStep(cpu, ram, { clearOnReadKeys: true });
    expect(cpu.a).toBe(0x51);
    expect(ram[KEY_STATUS]).toBe(0);
    expect(ram[KEY_DATA]).toBe(0x51);
  });
});
