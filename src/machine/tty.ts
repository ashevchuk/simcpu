import { FB_COLS, FB_ROWS, fbIndex, softIoLayoutForRam } from './memoryMap.js';

/**
 * Soft keyboard helpers over KEY_STATUS / KEY_DATA.
 *
 * Clear-on-read: soft path via softZ80 SoftMemHooks (clearOnReadKeys); gate
 * path via solver applyRamKeyClearOnRead after a settled OE read of KEY_DATA.
 * injectKey is unchanged — it only posts a key (KEY_DATA + KEY_STATUS=1).
 * Addresses follow softIoLayoutForRam (12-bit @ F00 or 64-bit CP/M @ F100).
 */

/** Write one ASCII cell into a RAM image (row-major framebuffer). */
export function paintCell(bytes: Uint8Array, col: number, row: number, ch: number): void {
  const L = softIoLayoutForRam(bytes);
  const addr = fbIndex(col, row, L.fbBase);
  if (addr >= bytes.length) {
    throw new RangeError(`framebuffer address 0x${addr.toString(16)} past RAM (${bytes.length} bytes)`);
  }
  bytes[addr] = ch & 0xff;
}

export function readFbChar(bytes: Uint8Array, col: number, row: number): number {
  const L = softIoLayoutForRam(bytes);
  const addr = fbIndex(col, row, L.fbBase);
  if (addr >= bytes.length) {
    throw new RangeError(`framebuffer address 0x${addr.toString(16)} past RAM (${bytes.length} bytes)`);
  }
  return bytes[addr]!;
}

/** UI / test helper: post a key into the soft keyboard registers. Overwrites if unread. */
export function injectKey(bytes: Uint8Array, code: number): void {
  const L = softIoLayoutForRam(bytes);
  if (L.keyData >= bytes.length || L.keyStatus >= bytes.length) {
    throw new RangeError('keyboard MMIO past RAM end — need addrBits >= 12');
  }
  bytes[L.keyData] = code & 0xff;
  bytes[L.keyStatus] = 1;
}

export function clearKeyStatus(bytes: Uint8Array): void {
  const L = softIoLayoutForRam(bytes);
  if (L.keyStatus < bytes.length) bytes[L.keyStatus] = 0;
}

/** Fill the whole framebuffer with spaces (or another fill byte). */
export function clearFramebuffer(bytes: Uint8Array, fill = 0x20): void {
  for (let row = 0; row < FB_ROWS; row++) {
    for (let col = 0; col < FB_COLS; col++) {
      paintCell(bytes, col, row, fill);
    }
  }
}
