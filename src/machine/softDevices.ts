/**
 * Soft-only I/O devices for the machine panel (not in 4K RAM).
 *
 * Port map (also exported from memoryMap.ts):
 *   0x01  PORT_TTY_OUT     OUT — write ASCII to text FB at advancing cursor
 *   0x02  PORT_KEY_STATUS  IN  — KEY_STATUS from RAM
 *   0x03  PORT_KEY_DATA    IN  — KEY_DATA and clear KEY_STATUS (clear-on-read)
 *   0x20  PORT_BMP_ADDR_LO OUT — low byte of 16-bit bitmap byte index
 *   0x21  PORT_BMP_ADDR_HI OUT — high byte of bitmap byte index
 *   0x22  PORT_BMP_DATA    OUT — write bitmap[addr]; IN — read bitmap[addr]
 *
 * Bitmap is a separate soft overlay (128×64 / 8 = 1024 bytes), not mapped into RAM.
 */

import {
  BMP_BYTES,
  BMP_HEIGHT,
  BMP_WIDTH,
  FB_COLS,
  FB_SIZE,
  KEY_DATA,
  KEY_STATUS,
  PORT_BMP_ADDR_HI,
  PORT_BMP_ADDR_LO,
  PORT_BMP_DATA,
  PORT_KEY_DATA,
  PORT_KEY_STATUS,
  PORT_TTY_OUT,
} from './memoryMap.js';
import { paintCell } from './tty.js';

export {
  BMP_BYTES,
  BMP_HEIGHT,
  BMP_WIDTH,
  PORT_BMP_ADDR_HI,
  PORT_BMP_ADDR_LO,
  PORT_BMP_DATA,
  PORT_KEY_DATA,
  PORT_KEY_STATUS,
  PORT_TTY_OUT,
};

export class SoftDevices {
  /** Soft bitmap framebuffer (not in RAM). */
  bitmap: Uint8Array;
  /** Optional text-FB write cursor for PORT_TTY_OUT (0 .. FB_SIZE-1). */
  fbCursor?: number;

  /** Internal 16-bit index into `bitmap`. */
  private bmpAddr = 0;

  constructor() {
    this.bitmap = new Uint8Array(BMP_BYTES);
  }

  clearBitmap(): void {
    this.bitmap.fill(0);
  }

  portOut(ram: Uint8Array, port: number, val: number): void {
    const p = port & 0xff;
    const v = val & 0xff;
    switch (p) {
      case PORT_BMP_ADDR_LO:
        this.bmpAddr = (this.bmpAddr & 0xff00) | v;
        break;
      case PORT_BMP_ADDR_HI:
        this.bmpAddr = (this.bmpAddr & 0x00ff) | (v << 8);
        break;
      case PORT_BMP_DATA:
        this.bitmap[this.bmpIndex()] = v;
        break;
      case PORT_TTY_OUT: {
        const cur = (this.fbCursor ?? 0) % FB_SIZE;
        const col = cur % FB_COLS;
        const row = (cur / FB_COLS) | 0;
        paintCell(ram, col, row, v);
        this.fbCursor = (cur + 1) % FB_SIZE;
        break;
      }
      default:
        break;
    }
  }

  portIn(ram: Uint8Array, port: number): number {
    const p = port & 0xff;
    switch (p) {
      case PORT_BMP_DATA:
        return this.bitmap[this.bmpIndex()]!;
      case PORT_KEY_STATUS:
        return ram[KEY_STATUS]! & 0xff;
      case PORT_KEY_DATA: {
        const data = ram[KEY_DATA]! & 0xff;
        ram[KEY_STATUS] = 0;
        return data;
      }
      default:
        return 0xff;
    }
  }

  private bmpIndex(): number {
    return this.bmpAddr % BMP_BYTES;
  }
}

export function createSoftDevices(): SoftDevices {
  return new SoftDevices();
}
