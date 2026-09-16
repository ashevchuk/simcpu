import { describe, expect, it } from 'vitest';
import { bootCpmSoft } from '../src/machine/cpm/boot.js';
import {
  CpmFileSystem,
  formatAndSeedDisk,
  formatFilename,
} from '../src/machine/cpm/fs.js';
import { SoftDisk } from '../src/machine/cpm/softDisk.js';
import {
  CPM_ADDR_BITS,
  CPM_BIOS_BASE,
  CPM_CCP_BASE,
  CPM_RAM_SIZE,
  CPM_TPA,
  CONSOLE_SIZE,
  softIoLayoutForAddrBits,
} from '../src/machine/memoryMap.js';
import { createSoftDevices } from '../src/machine/softDevices.js';
import { createSoftZ80, softRun, type SoftMemHooks } from '../src/machine/softZ80.js';
import { injectKey } from '../src/machine/tty.js';

function fbText(devices: ReturnType<typeof createSoftDevices>, n = CONSOLE_SIZE): string {
  let text = '';
  for (let i = 0; i < n; i++) {
    const c = devices.consoleFb[i] ?? 0;
    if (c >= 0x20 && c < 0x7f) text += String.fromCharCode(c);
    else if (c === 0x0a) text += '\n';
  }
  return text;
}

function makeHooks(ram: Uint8Array, devices: ReturnType<typeof createSoftDevices>): SoftMemHooks {
  return {
    addrBits: 16,
    clearOnReadKeys: true,
    keyDataAddr: 0xf101,
    keyStatusAddr: 0xf100,
    portIn: (p) => devices.portIn(ram, p),
    portOut: (p, v) => devices.portOut(ram, p, v),
    hostTrap: (cpu, bytes) => {
      const cpm = devices.cpm;
      if (!cpm) return false;
      return cpm.handleTrap(cpu, bytes, devices);
    },
  };
}

function typeLine(ram: Uint8Array, devices: ReturnType<typeof createSoftDevices>, cpu: ReturnType<typeof createSoftZ80>, hooks: SoftMemHooks, line: string): void {
  for (const ch of line) {
    injectKey(ram, ch.charCodeAt(0));
    softRun(cpu, ram, 5000, hooks);
  }
  injectKey(ram, 0x0d);
  softRun(cpu, ram, 20000, hooks);
}

describe('soft CP/M with disk', () => {
  it('uses high FB/keys layout for 64K', () => {
    const L = softIoLayoutForAddrBits(CPM_ADDR_BITS);
    expect(L.ramSize).toBe(CPM_RAM_SIZE);
  });

  it('formats disk with README.TXT and HELLO.COM', () => {
    const disk = new SoftDisk();
    const fs = formatAndSeedDisk(disk);
    const files = fs.list().map((f) => formatFilename(f.name, f.ext));
    expect(files).toContain('README.TXT');
    expect(files).toContain('HELLO.COM');
    const readme = fs.readFile('README.TXT');
    expect(readme).toBeTruthy();
    expect(new TextDecoder().decode(readme!).includes('Soft CP/M')).toBe(true);
  });

  it('ERA / REN round-trip on filesystem', () => {
    const fs = formatAndSeedDisk(new SoftDisk());
    expect(fs.renameFile('README.TXT', 'NOTE.TXT')).toBe(true);
    expect(fs.fileExists('NOTE.TXT')).toBe(true);
    expect(fs.fileExists('README.TXT')).toBe(false);
    expect(fs.deleteFile('NOTE.TXT')).toBe(true);
    expect(fs.fileExists('NOTE.TXT')).toBe(false);
  });

  it('boots to A> and DIR lists seeded files', () => {
    const ram = new Uint8Array(CPM_RAM_SIZE);
    const devices = createSoftDevices();
    const cpm = bootCpmSoft(ram, devices.disk);
    devices.cpm = cpm;
    expect(ram[0]).toBe(0xc3);
    expect(ram[5]).toBe(0xc3);
    expect(ram[CPM_BIOS_BASE]).toBe(0xc3);

    const cpu = createSoftZ80(0xe3ff);
    const hooks = makeHooks(ram, devices);
    softRun(cpu, ram, 80000, hooks);
    expect(fbText(devices)).toContain('CP/M');
    expect(fbText(devices)).toContain('A>');
    expect(cpu.pc).toBe(CPM_CCP_BASE);

    typeLine(ram, devices, cpu, hooks, 'DIR');
    const text = fbText(devices);
    expect(text).toContain('README.TXT');
    expect(text).toContain('HELLO.COM');
  });

  it('TYPE README shows file contents', () => {
    const ram = new Uint8Array(CPM_RAM_SIZE);
    const devices = createSoftDevices();
    devices.cpm = bootCpmSoft(ram, devices.disk);
    const cpu = createSoftZ80(0xe3ff);
    const hooks = makeHooks(ram, devices);
    softRun(cpu, ram, 80000, hooks);
    typeLine(ram, devices, cpu, hooks, 'TYPE README.TXT');
    expect(fbText(devices)).toContain('Soft CP/M disk ready');
  });

  it('runs HELLO.COM from disk via BDOS print', () => {
    const ram = new Uint8Array(CPM_RAM_SIZE);
    const devices = createSoftDevices();
    devices.cpm = bootCpmSoft(ram, devices.disk);
    const cpu = createSoftZ80(0xe3ff);
    const hooks = makeHooks(ram, devices);
    softRun(cpu, ram, 80000, hooks);
    typeLine(ram, devices, cpu, hooks, 'HELLO');
    softRun(cpu, ram, 50000, hooks);
    expect(fbText(devices)).toContain('HELLO FROM DISK');
    // back at CCP
    expect(cpu.pc === CPM_CCP_BASE || fbText(devices).includes('A>')).toBe(true);
    void CPM_TPA;
  });

  it('reads/writes a disk sector via SoftDisk', () => {
    const disk = new SoftDisk();
    const ram = new Uint8Array(CPM_RAM_SIZE);
    for (let i = 0; i < 128; i++) ram[0x80 + i] = i & 0xff;
    disk.writeSector(ram, 0, 1, 0x80);
    ram.fill(0, 0x80, 0x80 + 128);
    disk.readSector(ram, 0, 1, 0x80);
    expect(ram[0x80]).toBe(0);
    expect(ram[0x80 + 127]).toBe(127);
    void CpmFileSystem;
  });
});
