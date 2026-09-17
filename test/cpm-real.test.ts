import { describe, expect, it } from 'vitest';
import { bootRealCpm, mountCpmDriveB } from '../src/machine/cpm/boot.js';
import { loadCpm22DiskImage } from '../src/machine/cpm/cpm22Disk.js';
import { loadRogueDiskImage } from '../src/machine/cpm/rogueDisk.js';
import { SoftDisk } from '../src/machine/cpm/softDisk.js';
import { CONSOLE_SIZE, CPM_RAM_SIZE } from '../src/machine/memoryMap.js';
import { createSoftDevices, PORT_CONDAT } from '../src/machine/softDevices.js';
import { createSoftZ80, softRun, type SoftMemHooks } from '../src/machine/softZ80.js';

function fbText(devices: ReturnType<typeof createSoftDevices>, n = CONSOLE_SIZE): string {
  let text = '';
  for (let i = 0; i < n; i++) {
    const c = devices.consoleFb[i] ?? 0;
    if (c >= 0x20 && c < 0x7f) text += String.fromCharCode(c);
  }
  return text.replace(/ +/g, ' ').trim();
}

function makeHooks(ram: Uint8Array, devices: ReturnType<typeof createSoftDevices>): SoftMemHooks {
  return {
    addrBits: 16,
    portIn: (p) => devices.portIn(ram, p),
    portOut: (p, v) => devices.portOut(ram, p, v),
    portInBlock: (p) => ((p & 0xff) === PORT_CONDAT ? devices.coninWouldBlock() : false),
  };
}

function typeLine(
  ram: Uint8Array,
  cpu: ReturnType<typeof createSoftZ80>,
  devices: ReturnType<typeof createSoftDevices>,
  hooks: SoftMemHooks,
  line: string,
): void {
  for (const ch of line) {
    devices.injectKey(ram, ch.charCodeAt(0));
    for (let i = 0; i < 200 && devices.keyWaiting; i++) softRun(cpu, ram, 2000, hooks);
  }
  devices.injectKey(ram, 0x0d);
  for (let i = 0; i < 200 && devices.keyWaiting; i++) softRun(cpu, ram, 2000, hooks);
  softRun(cpu, ram, 200000, hooks);
}

describe('real CP/M 2.2 (z80pack cpm22-1.dsk)', () => {
  it('embeds a full 8" SS SD image', () => {
    const img = loadCpm22DiskImage();
    expect(img.length).toBe(256256);
    expect(img[0]).toBe(0xc3);
  });

  it('cold-boots to A> via on-disk CBIOS', () => {
    const ram = new Uint8Array(CPM_RAM_SIZE);
    const devices = createSoftDevices(new SoftDisk());
    devices.realCpm = true;
    devices.clearConsole();
    bootRealCpm(ram, devices.disk, loadCpm22DiskImage());
    const cpu = createSoftZ80(0xffff);
    const hooks = makeHooks(ram, devices);
    softRun(cpu, ram, 250000, hooks);
    const text = fbText(devices);
    expect(text).toContain('CP/M');
    expect(text).toMatch(/A>/);
    expect(ram[5]).toBe(0xc3);
    expect(text).not.toMatch(/\^@/);
  });

  it('DIR lists files from the real disk directory', () => {
    const ram = new Uint8Array(CPM_RAM_SIZE);
    const devices = createSoftDevices(new SoftDisk());
    devices.realCpm = true;
    devices.clearConsole();
    bootRealCpm(ram, devices.disk, loadCpm22DiskImage());
    const cpu = createSoftZ80(0xffff);
    const hooks = makeHooks(ram, devices);
    softRun(cpu, ram, 250000, hooks);
    expect(fbText(devices)).toMatch(/A>/);
    typeLine(ram, cpu, devices, hooks, 'DIR');
    const text = fbText(devices).toUpperCase();
    expect(text).toMatch(/DUMP/);
    expect(text).toMatch(/A>/);
  });

  it('mounts rogue.dsk as B: and DIR B: shows ROGUE-VT', () => {
    const ram = new Uint8Array(CPM_RAM_SIZE);
    const devices = createSoftDevices(new SoftDisk());
    devices.realCpm = true;
    devices.clearConsole();
    bootRealCpm(ram, devices.disk, loadCpm22DiskImage());
    mountCpmDriveB(devices, loadRogueDiskImage());
    expect(loadRogueDiskImage().length).toBe(256256);
    const cpu = createSoftZ80(0xffff);
    const hooks = makeHooks(ram, devices);
    softRun(cpu, ram, 250000, hooks);
    typeLine(ram, cpu, devices, hooks, 'B:');
    typeLine(ram, cpu, devices, hooks, 'DIR');
    const text = fbText(devices).toUpperCase();
    expect(text).toMatch(/ROGUE/);
  });

  it('VT100 clear screen via CONOUT', () => {
    const ram = new Uint8Array(16);
    const devices = createSoftDevices();
    devices.portOut(ram, PORT_CONDAT, 'X'.charCodeAt(0));
    expect(devices.consoleFb[0]).toBe('X'.charCodeAt(0));
    for (const ch of '\x1b[2J\x1b[H') devices.portOut(ram, PORT_CONDAT, ch.charCodeAt(0));
    expect(devices.consoleFb[0]).toBe(0x20);
    expect(devices.vt.row).toBe(0);
    expect(devices.vt.col).toBe(0);
  });
});
