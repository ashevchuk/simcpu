import { FB_COLS, FB_ROWS, KEY_DATA, KEY_STATUS, fbIndex } from './memoryMap.js';

/**
 * Soft keyboard helpers over KEY_STATUS / KEY_DATA.
 *
 * Clear-on-read: soft path via softZ80 SoftMemHooks (clearOnReadKeys); gate
 * path via solver applyRamKeyClearOnRead after a settled OE read of KEY_DATA.
 * injectKey is unchanged — it only posts a key (KEY_DATA + KEY_STATUS=1).
 */

/** Write one ASCII cell into a RAM image (row-major framebuffer). */
export function paintCell(bytes: Uint8Array, col: number, row: number, ch: number): void {
  const addr = fbIndex(col, row);
  if (addr >= bytes.length) {
    throw new RangeError(`framebuffer address 0x${addr.toString(16)} past RAM (${bytes.length} bytes)`);
  }
  bytes[addr] = ch & 0xff;
}

export function readFbChar(bytes: Uint8Array, col: number, row: number): number {
  const addr = fbIndex(col, row);
  if (addr >= bytes.length) {
    throw new RangeError(`framebuffer address 0x${addr.toString(16)} past RAM (${bytes.length} bytes)`);
  }
  return bytes[addr]!;
}

/** UI / test helper: post a key into the soft keyboard registers. Overwrites if unread. */
export function injectKey(bytes: Uint8Array, code: number): void {
  if (KEY_DATA >= bytes.length || KEY_STATUS >= bytes.length) {
    throw new RangeError('keyboard MMIO past RAM end — need addrBits >= 12');
  }
  bytes[KEY_DATA] = code & 0xff;
  bytes[KEY_STATUS] = 1;
}

export function clearKeyStatus(bytes: Uint8Array): void {
  if (KEY_STATUS < bytes.length) bytes[KEY_STATUS] = 0;
}

/** Fill the whole framebuffer with spaces (or another fill byte). */
export function clearFramebuffer(bytes: Uint8Array, fill = 0x20): void {
  for (let row = 0; row < FB_ROWS; row++) {
    for (let col = 0; col < FB_COLS; col++) {
      paintCell(bytes, col, row, fill);
    }
  }
}
