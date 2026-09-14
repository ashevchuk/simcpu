import { describe, expect, it } from 'vitest';
import {
  FB_BASE,
  FB_COLS,
  FB_END,
  FB_ROWS,
  FB_SIZE,
  KEY_DATA,
  KEY_STATUS,
  MACHINE_ADDR_BITS,
  MACHINE_RAM_SIZE,
  fbIndex,
  isFbAddr,
  requiresMachineMap,
} from '../src/machine/memoryMap.js';
import { clearFramebuffer, clearKeyStatus, injectKey, paintCell, readFbChar } from '../src/machine/tty.js';

describe('memoryMap', () => {
  it('locks the 12-bit machine layout', () => {
    expect(MACHINE_ADDR_BITS).toBe(12);
    expect(MACHINE_RAM_SIZE).toBe(4096);
    expect(FB_BASE).toBe(0xe00);
    expect(FB_SIZE).toBe(256);
    expect(FB_END).toBe(0xf00);
    expect(FB_COLS * FB_ROWS).toBe(FB_SIZE);
    expect(KEY_STATUS).toBe(0xf00);
    expect(KEY_DATA).toBe(0xf01);
    expect(requiresMachineMap(11)).toBe(false);
    expect(requiresMachineMap(12)).toBe(true);
  });

  it('indexes the framebuffer row-major', () => {
    expect(fbIndex(0, 0)).toBe(FB_BASE);
    expect(fbIndex(FB_COLS - 1, 0)).toBe(FB_BASE + FB_COLS - 1);
    expect(fbIndex(0, 1)).toBe(FB_BASE + FB_COLS);
    expect(fbIndex(3, 2)).toBe(FB_BASE + 2 * FB_COLS + 3);
    expect(isFbAddr(FB_BASE)).toBe(true);
    expect(isFbAddr(FB_END - 1)).toBe(true);
    expect(isFbAddr(FB_END)).toBe(false);
    expect(() => fbIndex(FB_COLS, 0)).toThrow(RangeError);
    expect(() => fbIndex(0, FB_ROWS)).toThrow(RangeError);
  });

  it('paintCell / readFbChar / keyboard helpers mutate a RAM image', () => {
    const bytes = new Uint8Array(MACHINE_RAM_SIZE);
    paintCell(bytes, 1, 0, 0x41);
    expect(readFbChar(bytes, 1, 0)).toBe(0x41);
    expect(bytes[FB_BASE + 1]).toBe(0x41);

    clearFramebuffer(bytes, 0x20);
    expect(bytes[FB_BASE]).toBe(0x20);
    expect(bytes[FB_END - 1]).toBe(0x20);

    injectKey(bytes, 'Q'.charCodeAt(0));
    expect(bytes[KEY_DATA]).toBe(0x51);
    expect(bytes[KEY_STATUS]).toBe(1);
    injectKey(bytes, 'Z'.charCodeAt(0)); // overwrite if unread
    expect(bytes[KEY_DATA]).toBe(0x5a);
    expect(bytes[KEY_STATUS]).toBe(1);
    clearKeyStatus(bytes);
    expect(bytes[KEY_STATUS]).toBe(0);
    expect(bytes[KEY_DATA]).toBe(0x5a);
  });
});
