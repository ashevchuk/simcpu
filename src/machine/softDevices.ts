/**
 * Soft-only I/O devices for the machine panel.
 *
 * Ports:
 *   0x00  CONSTA   IN  — 0xFF key waiting / 0 empty (z80pack CBIOS)
 *   0x01  CONDAT   OUT ASCII/VT100 → host console; IN → key (clear-on-read)
 *   0x02  PRTSTA   IN  — printer ready (0xFF) / soft key status when !realCpm
 *   0x03  PRTDAT   OUT ignored (and legacy PORT_KEY_DATA alias when not z80pack-disk)
 *   0x0A–0x10     z80pack FDC + DMA (drive/track/sector/cmd/status/dma)
 *   0x20–0x22     soft bitmap
 *   0x30          legacy soft BIOS disk op
 */

import {
  BMP_BYTES,
  BMP_HEIGHT,
  BMP_WIDTH,
  PORT_BMP_ADDR_HI,
  PORT_BMP_ADDR_LO,
  PORT_BMP_DATA,
  PORT_DISK_OP,
  PORT_KEY_DATA,
  PORT_KEY_STATUS,
  PORT_TTY_OUT,
  softIoLayoutForRam,
} from './memoryMap.js';
import type { SoftCpm } from './cpm/host.js';
import { BIOS_DMA, BIOS_SECTOR, BIOS_TRACK, CPM_SECS_PER_TRACK, SoftDisk, createSoftDisk } from './cpm/softDisk.js';
import { Vt100Terminal } from './vt100.js';

export {
  BMP_BYTES,
  BMP_HEIGHT,
  BMP_WIDTH,
  PORT_BMP_ADDR_HI,
  PORT_BMP_ADDR_LO,
  PORT_BMP_DATA,
  PORT_DISK_OP,
  PORT_KEY_DATA,
  PORT_KEY_STATUS,
  PORT_TTY_OUT,
};

/** z80pack cpmsim FDC / console ports (CBIOS). */
export const PORT_CONSTA = 0x00;
export const PORT_CONDAT = 0x01;
export const PORT_PRTSTA = 0x02;
export const PORT_PRTDAT = 0x03;
export const PORT_AUXDAT = 0x05;
export const PORT_FDCD = 0x0a;
export const PORT_FDCT = 0x0b;
export const PORT_FDCS = 0x0c;
export const PORT_FDCOP = 0x0d;
export const PORT_FDCST = 0x0e;
export const PORT_DMAL = 0x0f;
export const PORT_DMAH = 0x10;

export class SoftDevices {
  bitmap: Uint8Array;
  /** VT100/ANSI host console (not in Z80 RAM). */
  readonly vt = new Vt100Terminal();
  /** Alias of vt.cells for panel / tests. */
  get consoleFb(): Uint8Array {
    return this.vt.cells;
  }
  get fbCursor(): number {
    return this.vt.cursorIndex;
  }
  set fbCursor(_v: number) {
    /* cursor owned by Vt100Terminal */
  }
  /** True after at least one port TTY character was painted. */
  consoleTouched = false;
  /** Drives A:… — index 0 is always present. */
  disks: SoftDisk[];
  /** Drive A: (boot / SoftCpm). */
  get disk(): SoftDisk {
    return this.disks[0]!;
  }
  set disk(d: SoftDisk) {
    this.disks[0] = d;
  }
  /** Host SoftCpm (stub CCP) — null when running real CP/M from disk. */
  cpm: SoftCpm | null = null;
  /** True after Boot CP/M loaded a real system image. */
  realCpm = false;
  diskStatus = 0;

  private bmpAddr = 0;
  private keyStatus = 0;
  private keyData = 0;

  /** z80pack FDC latches */
  private fdcDrive = 0;
  private fdcTrack = 0;
  private fdcSector = 1;
  private fdcDma = 0x80;
  private fdcStatus = 0;

  constructor(disk?: SoftDisk) {
    this.bitmap = new Uint8Array(BMP_BYTES);
    this.disks = [disk ?? createSoftDisk()];
  }

  /** Mount SoftDisk on drive 0–3 (z80pack FD). */
  setDrive(drive: number, disk: SoftDisk | null): void {
    if (drive < 0 || drive > 3) throw new RangeError(`drive ${drive}`);
    if (drive === 0) {
      if (!disk) throw new Error('drive A: required');
      this.disks[0] = disk;
      return;
    }
    while (this.disks.length <= drive) this.disks.push(createSoftDisk());
    if (disk) this.disks[drive] = disk;
    else this.disks[drive] = createSoftDisk(); // empty placeholder
  }

  clearBitmap(): void {
    this.bitmap.fill(0);
  }

  clearConsole(): void {
    this.vt.clear();
    this.consoleTouched = false;
  }

  /** Post a key for z80pack CONSTA/CONDAT (real CP/M) or RAM keys (soft stub). */
  injectKey(ram: Uint8Array, code: number): void {
    if (this.realCpm) {
      this.keyData = code & 0xff;
      this.keyStatus = 1;
      return;
    }
    const L = softIoLayoutForRam(ram);
    ram[L.keyData] = code & 0xff;
    ram[L.keyStatus] = 1;
  }

  /** True while a key is waiting for CONIN. */
  get keyWaiting(): boolean {
    return this.keyStatus !== 0;
  }

  /** z80pack CONDAT blocks until a key is posted (BIOS CONIN does not spin). */
  coninWouldBlock(): boolean {
    return this.realCpm && this.keyStatus === 0;
  }

  portOut(ram: Uint8Array, port: number, val: number): void {
    const p = port & 0xff;
    const v = val & 0xff;
    switch (p) {
      case PORT_CONDAT:
      case PORT_TTY_OUT:
        this.consoleTouched = true;
        this.vt.write(v);
        break;
      case PORT_PRTDAT:
      case PORT_AUXDAT:
        break;
      case PORT_FDCD:
        this.fdcDrive = v;
        break;
      case PORT_FDCT:
        this.fdcTrack = v;
        break;
      case PORT_FDCS:
        this.fdcSector = v;
        break;
      case PORT_DMAL:
        this.fdcDma = (this.fdcDma & 0xff00) | v;
        break;
      case PORT_DMAH:
        this.fdcDma = (this.fdcDma & 0x00ff) | (v << 8);
        break;
      case PORT_FDCOP:
        this.fdcDo(ram, v);
        break;
      case PORT_BMP_ADDR_LO:
        this.bmpAddr = (this.bmpAddr & 0xff00) | v;
        break;
      case PORT_BMP_ADDR_HI:
        this.bmpAddr = (this.bmpAddr & 0x00ff) | (v << 8);
        break;
      case PORT_BMP_DATA:
        this.bitmap[this.bmpIndex()] = v;
        break;
      case PORT_DISK_OP: {
        try {
          const track = ram[BIOS_TRACK]! & 0xff;
          const sector = ram[BIOS_SECTOR]! & 0xff;
          const dma = ram[BIOS_DMA]! | (ram[BIOS_DMA + 1]! << 8);
          if (v === 0) this.disk.readSector(ram, track, sector, dma);
          else this.disk.writeSector(ram, track, sector, dma);
          this.diskStatus = 0;
        } catch {
          this.diskStatus = 1;
        }
        break;
      }
      default:
        break;
    }
  }

  portIn(ram: Uint8Array, port: number): number {
    const p = port & 0xff;
    const L = softIoLayoutForRam(ram);
    switch (p) {
      case PORT_CONSTA:
        if (this.realCpm) return this.keyStatus ? 0xff : 0x00;
        return (ram[L.keyStatus]! & 0xff) !== 0 ? 0xff : 0x00;
      case PORT_CONDAT:
      case PORT_KEY_DATA: {
        if (this.realCpm) {
          this.keyStatus = 0;
          return this.keyData & 0xff;
        }
        const data = ram[L.keyData]! & 0xff;
        ram[L.keyStatus] = 0;
        return data;
      }
      case PORT_PRTSTA:
      case PORT_KEY_STATUS:
        if (this.realCpm) return 0xff;
        return ram[L.keyStatus]! & 0xff;
      case PORT_AUXDAT:
        return 0x1a;
      case PORT_FDCD:
        return this.fdcDrive & 0xff;
      case PORT_FDCT:
        return this.fdcTrack & 0xff;
      case PORT_FDCS:
        return this.fdcSector & 0xff;
      case PORT_FDCST:
        return this.fdcStatus & 0xff;
      case PORT_DMAL:
        return this.fdcDma & 0xff;
      case PORT_DMAH:
        return (this.fdcDma >> 8) & 0xff;
      case PORT_BMP_DATA:
        return this.bitmap[this.bmpIndex()]!;
      case PORT_DISK_OP:
        return this.diskStatus & 0xff;
      default:
        return 0xff;
    }
  }

  private fdcDo(ram: Uint8Array, cmd: number): void {
    const disk = this.disks[this.fdcDrive];
    if (!disk) {
      this.fdcStatus = 1;
      return;
    }
    if (this.fdcTrack < 0 || this.fdcTrack >= 77) {
      this.fdcStatus = 2;
      return;
    }
    if (this.fdcSector < 1 || this.fdcSector > CPM_SECS_PER_TRACK) {
      this.fdcStatus = 3;
      return;
    }
    try {
      if (cmd === 0) disk.readSector(ram, this.fdcTrack, this.fdcSector, this.fdcDma);
      else if (cmd === 1) disk.writeSector(ram, this.fdcTrack, this.fdcSector, this.fdcDma);
      else {
        this.fdcStatus = 7;
        return;
      }
      this.fdcStatus = 0;
    } catch {
      this.fdcStatus = 5;
    }
  }

  private bmpIndex(): number {
    return this.bmpAddr % BMP_BYTES;
  }
}

export function createSoftDevices(disk?: SoftDisk): SoftDevices {
  return new SoftDevices(disk);
}
