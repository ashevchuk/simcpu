/**
 * Soft memory map for the interactive Z80 machine demo (addrBits >= 12).
 * Display and keyboard are behavioral overlays on RamComponent.bytes — not
 * transistor-level devices (same performance trade-off as Real RAM itself).
 *
 * Layout (4 KiB when addrBits = 12):
 *   0x000–0xDFF  program / general RAM
 *   0xE00–0xEFF  text framebuffer (32×8 ASCII cells, row-major)
 *   0xF00        keyboard status (0 = empty, 1 = key waiting)
 *   0xF01        keyboard data (last key byte)
 *   0xF02–0xFFF  reserved
 */

export const MACHINE_ADDR_BITS = 12;
export const MACHINE_RAM_SIZE = 1 << MACHINE_ADDR_BITS; // 4096

export const FB_BASE = 0xe00;
export const FB_COLS = 32;
export const FB_ROWS = 8;
export const FB_SIZE = FB_COLS * FB_ROWS; // 256
export const FB_END = FB_BASE + FB_SIZE; // 0xF00 exclusive

export const KEY_STATUS = 0xf00;
export const KEY_DATA = 0xf01;

export function fbIndex(col: number, row: number): number {
  if (col < 0 || col >= FB_COLS || row < 0 || row >= FB_ROWS) {
    throw new RangeError(`fb cell (${col},${row}) out of range ${FB_COLS}x${FB_ROWS}`);
  }
  return FB_BASE + row * FB_COLS + col;
}

export function isFbAddr(addr: number): boolean {
  return addr >= FB_BASE && addr < FB_END;
}

export function requiresMachineMap(addrBits: number): boolean {
  return addrBits >= MACHINE_ADDR_BITS;
}
