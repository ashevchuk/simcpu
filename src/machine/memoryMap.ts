/**
 * Soft memory map for the interactive Z80 machine demo (addrBits >= 12).
 * Display and keyboard are behavioral overlays on RamComponent.bytes — not
 * transistor-level devices (same performance trade-off as Real RAM itself).
 *
 * Layout (4 KiB when addrBits = 12):
 *   0x000–0xDFF  program / general RAM
 *   0xE00–0xEFF  text framebuffer (32×8 ASCII cells, row-major)
 *   0xF00        keyboard status (0 = empty, 1 = key waiting)
 *   0xF01        keyboard data (last key byte; reading clears KEY_STATUS —
 *                soft SoftMemHooks and gate solver applyRamKeyClearOnRead)
 *   0xF02–0xFFF  reserved
 *
 * Soft-only overlays (not stored in the 4K RAM image — see softDevices.ts):
 *   Port I/O reserved numbers (IN/OUT, SoftDevices.portIn/portOut):
 *     0x01  PORT_TTY_OUT      OUT ASCII → text FB (advancing cursor)
 *     0x02  PORT_KEY_STATUS   IN  → KEY_STATUS
 *     0x03  PORT_KEY_DATA     IN  → KEY_DATA, clear KEY_STATUS
 *     0x20  PORT_BMP_ADDR_LO  OUT bitmap byte-index low
 *     0x21  PORT_BMP_ADDR_HI  OUT bitmap byte-index high
 *     0x22  PORT_BMP_DATA     OUT/IN bitmap[addr]
 *   Bitmap framebuffer: BMP_WIDTH×BMP_HEIGHT / 8 bytes on SoftDevices.bitmap
 */

export const MACHINE_ADDR_BITS = 12;
export const MACHINE_RAM_SIZE = 1 << MACHINE_ADDR_BITS; // 4096

/** Soft CP/M path uses a full 64K address space (soft interpreter). */
export const CPM_ADDR_BITS = 16;
export const CPM_RAM_SIZE = 1 << CPM_ADDR_BITS; // 65536

export const FB_BASE = 0xe00;
export const FB_COLS = 32;
export const FB_ROWS = 8;
export const FB_SIZE = FB_COLS * FB_ROWS; // 256
export const FB_END = FB_BASE + FB_SIZE; // 0xF00 exclusive

/**
 * Host-side soft console (SoftDevices.consoleFb) — not mapped into Z80 RAM.
 * Classic CP/M size; RAM FB stays 32×8 for the 4K machine map / BASIC poke demos.
 */
export const CONSOLE_COLS = 80;
export const CONSOLE_ROWS = 25;
export const CONSOLE_SIZE = CONSOLE_COLS * CONSOLE_ROWS;

export const KEY_STATUS = 0xf00;
export const KEY_DATA = 0xf01;

/**
 * 64K soft layout: keep TPA (0x0100…) free; park FB/keys just below BIOS.
 *   0xF000–0xF0FF  text FB
 *   0xF100/0xF101  KEY_STATUS / KEY_DATA
 *   0xFE00+        BIOS jump table
 */
export const CPM_FB_BASE = 0xf000;
export const CPM_FB_END = CPM_FB_BASE + FB_SIZE;
export const CPM_KEY_STATUS = 0xf100;
export const CPM_KEY_DATA = 0xf101;
export const CPM_BIOS_BASE = 0xfe00;
export const CPM_BDOS_BASE = 0xec00;
export const CPM_CCP_BASE = 0xe400;
export const CPM_STACK = 0xe3ff;
export const CPM_TPA = 0x0100;

/** Soft I/O window derived from address width (or RAM byte length). */
export interface SoftIoLayout {
  addrBits: number;
  ramSize: number;
  fbBase: number;
  fbEnd: number;
  keyStatus: number;
  keyData: number;
  stackTop: number;
  /** Soft reserved region start (loadHex refuses past this unless allowIo). */
  ioGuard: number;
}

export function softIoLayoutForAddrBits(addrBits: number): SoftIoLayout {
  if (addrBits >= CPM_ADDR_BITS) {
    return {
      addrBits: CPM_ADDR_BITS,
      ramSize: CPM_RAM_SIZE,
      fbBase: CPM_FB_BASE,
      fbEnd: CPM_FB_END,
      keyStatus: CPM_KEY_STATUS,
      keyData: CPM_KEY_DATA,
      stackTop: CPM_STACK,
      ioGuard: CPM_FB_BASE,
    };
  }
  return {
    addrBits: MACHINE_ADDR_BITS,
    ramSize: MACHINE_RAM_SIZE,
    fbBase: FB_BASE,
    fbEnd: FB_END,
    keyStatus: KEY_STATUS,
    keyData: KEY_DATA,
    stackTop: 0xdff,
    ioGuard: KEY_STATUS,
  };
}

export function softIoLayoutForRam(ram: Uint8Array): SoftIoLayout {
  if (ram.length >= CPM_RAM_SIZE) return softIoLayoutForAddrBits(CPM_ADDR_BITS);
  return softIoLayoutForAddrBits(MACHINE_ADDR_BITS);
}

/** Soft bitmap size (hosted by SoftDevices, not in RAM). */
export const BMP_WIDTH = 128;
export const BMP_HEIGHT = 64;
export const BMP_BYTES = (BMP_WIDTH * BMP_HEIGHT) / 8; // 1024

/** Soft port numbers (SoftDevices). */
export const PORT_TTY_OUT = 0x01;
export const PORT_KEY_STATUS = 0x02;
export const PORT_KEY_DATA = 0x03;
export const PORT_BMP_ADDR_LO = 0x20;
export const PORT_BMP_ADDR_HI = 0x21;
export const PORT_BMP_DATA = 0x22;
/** Soft CP/M disk: OUT 0=read/1=write using BIOS workspace; IN = status (0=OK). */
export const PORT_DISK_OP = 0x30;

export function fbIndex(col: number, row: number, fbBase = FB_BASE): number {
  if (col < 0 || col >= FB_COLS || row < 0 || row >= FB_ROWS) {
    throw new RangeError(`fb cell (${col},${row}) out of range ${FB_COLS}x${FB_ROWS}`);
  }
  return fbBase + row * FB_COLS + col;
}

export function isFbAddr(addr: number, layout?: SoftIoLayout): boolean {
  const L = layout ?? softIoLayoutForAddrBits(MACHINE_ADDR_BITS);
  return addr >= L.fbBase && addr < L.fbEnd;
}

export function requiresMachineMap(addrBits: number): boolean {
  return addrBits >= MACHINE_ADDR_BITS;
}
