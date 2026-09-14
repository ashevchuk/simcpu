import { describe, expect, it } from 'vitest';
import { KEY_DATA, KEY_STATUS } from '../src/machine/memoryMap.js';
import { MONITOR_BYTES, loadMonitor, monitorHexPrompt } from '../src/machine/monitor.js';

describe('soft echo monitor image', () => {
  it('starts with LD HL,0xE00 and touches keyboard MMIO', () => {
    expect(MONITOR_BYTES[0]).toBe(0x21);
    expect(MONITOR_BYTES[1]).toBe(0x00);
    expect(MONITOR_BYTES[2]).toBe(0x0e);
    expect(MONITOR_BYTES[3]).toBe(0x3e);
    expect(MONITOR_BYTES[4]).toBe(0x3e); // '>'

    const hex = monitorHexPrompt();
    expect(hex.startsWith('21,00,0e')).toBe(true);

    // Absolute loads/stores of KEY_STATUS (0xF00) and KEY_DATA (0xF01)
    const hasStatusLoad = [...MONITOR_BYTES.keys()].some(
      (i) => MONITOR_BYTES[i] === 0x3a && MONITOR_BYTES[i + 1] === (KEY_STATUS & 0xff) && MONITOR_BYTES[i + 2] === KEY_STATUS >> 8,
    );
    const hasDataLoad = [...MONITOR_BYTES.keys()].some(
      (i) => MONITOR_BYTES[i] === 0x3a && MONITOR_BYTES[i + 1] === (KEY_DATA & 0xff) && MONITOR_BYTES[i + 2] === KEY_DATA >> 8,
    );
    const hasStatusStore = [...MONITOR_BYTES.keys()].some(
      (i) => MONITOR_BYTES[i] === 0x32 && MONITOR_BYTES[i + 1] === (KEY_STATUS & 0xff) && MONITOR_BYTES[i + 2] === KEY_STATUS >> 8,
    );
    expect(hasStatusLoad).toBe(true);
    expect(hasDataLoad).toBe(true);
    expect(hasStatusStore).toBe(true);
  });

  it('loadMonitor copies into a RAM image at offset 0', () => {
    const ram = new Uint8Array(4096);
    ram.fill(0xff);
    loadMonitor(ram);
    expect(ram.subarray(0, MONITOR_BYTES.length)).toEqual(MONITOR_BYTES);
    expect(ram[MONITOR_BYTES.length]).toBe(0xff);
  });
});
