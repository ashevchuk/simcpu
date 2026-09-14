import { describe, expect, it } from 'vitest';
import { FB_BASE, KEY_STATUS } from '../src/machine/memoryMap.js';
import { MONITOR_BYTES } from '../src/machine/monitor.js';
import { loadHexAt, parseHexBlob, runSoftCommand } from '../src/machine/softConsole.js';

describe('softConsole', () => {
  it('dumps, writes, reloads monitor, and patches JP for G', () => {
    const ram = new Uint8Array(4096);
    ram[FB_BASE] = 0x3e;

    const dump = runSoftCommand(ram, 'M e00 2');
    expect(dump.ok).toBe(true);
    expect(dump.message).toContain('e00:');
    expect(dump.message).toContain('3e');

    const write = runSoftCommand(ram, 'W 0100 41 42');
    expect(write.ok).toBe(true);
    expect(ram[0x100]).toBe(0x41);
    expect(ram[0x101]).toBe(0x42);

    const help = runSoftCommand(ram, 'H');
    expect(help.ok).toBe(true);
    expect(help.message.toLowerCase()).toContain('help');

    const go = runSoftCommand(ram, 'G 100');
    expect(go.ok).toBe(true);
    expect(go.reboot).toBe(true);
    expect(ram[0]).toBe(0xc3);
    expect(ram[1]).toBe(0x00);
    expect(ram[2]).toBe(0x01);

    const rel = runSoftCommand(ram, 'R');
    expect(rel.ok).toBe(true);
    expect(ram.subarray(0, 4)).toEqual(MONITOR_BYTES.subarray(0, 4));
  });

  it('parses hex blobs and loadHexAt refuses KEY region', () => {
    expect(parseHexBlob('3e, 41 32')).toEqual([0x3e, 0x41, 0x32]);
    expect(parseHexBlob('zz')).toBeNull();

    const ram = new Uint8Array(4096);
    const ok = loadHexAt(ram, 0x100, [1, 2, 3]);
    expect(ok.ok).toBe(true);
    expect(ram[0x100]).toBe(1);

    const bad = loadHexAt(ram, KEY_STATUS, [0]);
    expect(bad.ok).toBe(false);

    const forced = loadHexAt(ram, KEY_STATUS, [1], { allowIo: true });
    expect(forced.ok).toBe(true);
    expect(ram[KEY_STATUS]).toBe(1);
  });

  it('rejects unknown commands', () => {
    const ram = new Uint8Array(4096);
    const r = runSoftCommand(ram, 'XYZ');
    expect(r.ok).toBe(false);
  });
});
