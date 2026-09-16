/**
 * Soft Beta 128 / WD1793 subset: sector R/W against a mounted .TRD image.
 * Ports 1F/3F/5F/7F/FF are active only while TR-DOS ROM is paged.
 *
 * Enough for TR-DOS ROM to seek/read/write sectors (CAT / load when image is
 * valid). Not a cycle-accurate WD1793 — timing bits are simplified.
 */

import { TRD_SECTOR_SIZE, TRD_SECTORS, type TrdInfo } from './expansions.js';

/** WD1793-ish status bits. */
const ST_BUSY = 0x01;
const ST_DRQ = 0x02;
const ST_TRACK0 = 0x04;
const ST_SEEK_ERR = 0x10;
const ST_NOT_FOUND = 0x10;
const ST_HEAD_LOADED = 0x20;
const ST_WRITE_PROTECT = 0x40;
const ST_NOT_READY = 0x80;

/**
 * Soft Beta Disk controller + system port.
 * System port (0xFF): bit0 pages TR-DOS ROM when set (common soft convention).
 */
export class BetaDisk {
  disk: TrdInfo | null = null;
  track = 0;
  sector = 1;
  side = 0;
  drive = 0;
  data = 0;
  status = 0;
  command = 0;
  writeProtect = false;
  /** Remaining bytes in current sector / address transfer. */
  private buf: Uint8Array | null = null;
  private bufPos = 0;
  private writing = false;
  /** Multi-sector read/write remaining count (soft: one extra sector max chain). */
  private multiLeft = 0;

  reset(): void {
    this.track = 0;
    this.sector = 1;
    this.side = 0;
    this.drive = 0;
    this.data = 0;
    this.status = this.typeIStatus();
    this.command = 0;
    this.buf = null;
    this.bufPos = 0;
    this.writing = false;
    this.multiLeft = 0;
  }

  mount(disk: TrdInfo | null): void {
    this.disk = disk;
    this.reset();
  }

  /** Absolute byte offset in TRD image for track/sector/side. */
  sectorOffset(track: number, sector: number, side: number): number {
    const sec = Math.max(1, Math.min(TRD_SECTORS, sector | 0)) - 1;
    const tr = Math.max(0, track | 0);
    const si = side & 1;
    const sideSize = TRD_SECTORS * TRD_SECTOR_SIZE * 80; // tracks assumed 80
    return si * sideSize + tr * TRD_SECTORS * TRD_SECTOR_SIZE + sec * TRD_SECTOR_SIZE;
  }

  private typeIStatus(): number {
    let st = ST_HEAD_LOADED;
    if (this.track === 0) st |= ST_TRACK0;
    if (!this.disk) st |= ST_NOT_READY;
    return st;
  }

  private loadSectorBuf(write: boolean): boolean {
    if (!this.disk) {
      this.status = ST_NOT_FOUND | ST_NOT_READY;
      this.buf = null;
      return false;
    }
    if (write && this.writeProtect) {
      this.status = ST_WRITE_PROTECT;
      this.buf = null;
      return false;
    }
    const off = this.sectorOffset(this.track, this.sector, this.side);
    if (off + TRD_SECTOR_SIZE > this.disk.bytes.length) {
      this.status = ST_NOT_FOUND;
      this.buf = null;
      return false;
    }
    // Writable view into image for write path
    this.buf = this.disk.bytes.subarray(off, off + TRD_SECTOR_SIZE);
    this.bufPos = 0;
    this.writing = write;
    this.status = ST_DRQ | ST_BUSY;
    return true;
  }

  private finishSectorOrContinue(): void {
    this.buf = null;
    this.bufPos = 0;
    if (this.multiLeft > 0) {
      this.multiLeft--;
      this.sector = (this.sector + 1) & 0xff;
      if (this.sector < 1 || this.sector > TRD_SECTORS) {
        this.sector = 1;
        this.track = (this.track + 1) & 0xff;
      }
      if (!this.loadSectorBuf(this.writing)) return;
      return;
    }
    this.writing = false;
    this.status = this.typeIStatus();
  }

  /** Command register (port 0x1F when TR-DOS paged). */
  outCommand(val: number): void {
    this.command = val & 0xff;
    const top = this.command & 0xf0;

    // Type I: restore / seek / step
    if (top === 0x00) {
      // Restore → track 0
      this.track = 0;
      this.status = this.typeIStatus();
      this.buf = null;
      this.multiLeft = 0;
      return;
    }
    if (top === 0x10) {
      // Seek — data register holds target track
      this.track = this.data & 0xff;
      this.status = this.typeIStatus();
      if (this.disk && this.track > 79) this.status |= ST_SEEK_ERR;
      this.buf = null;
      this.multiLeft = 0;
      return;
    }
    if (top === 0x20 || top === 0x30 || top === 0x40 || top === 0x50 || top === 0x60 || top === 0x70) {
      // Step / step-in / step-out — soft: ±1 track
      const dirIn = top === 0x40 || top === 0x50 || (top === 0x20 && (this.command & 0x20) === 0);
      // WD1793: 0x40/0x50 step-in, 0x60/0x70 step-out; 0x20/0x30 step with last direction
      if (top === 0x60 || top === 0x70) {
        this.track = Math.max(0, this.track - 1);
      } else if (top === 0x40 || top === 0x50) {
        this.track = Math.min(79, this.track + 1);
      } else {
        // step — treat as step-in for soft demos
        void dirIn;
        this.track = Math.min(79, this.track + 1);
      }
      this.status = this.typeIStatus();
      this.buf = null;
      this.multiLeft = 0;
      return;
    }

    if (top === 0x80 || top === 0xa0) {
      // Read / write sector; bit2 (0x04) = multiple sector
      this.multiLeft = this.command & 0x04 ? 1 : 0; // soft: at most one extra
      this.loadSectorBuf(top === 0xa0);
      return;
    }

    if (top === 0xc0) {
      // Read address — 6 bytes: track, side, sector, length-code, crc, crc
      const addr = new Uint8Array([
        this.track & 0xff,
        this.side & 1,
        this.sector & 0xff,
        0x01, // 256-byte sectors
        0,
        0,
      ]);
      this.buf = addr;
      this.bufPos = 0;
      this.writing = false;
      this.multiLeft = 0;
      this.status = ST_DRQ | ST_BUSY;
      return;
    }

    if (top === 0xd0) {
      // Force interrupt
      this.status = this.typeIStatus();
      this.buf = null;
      this.multiLeft = 0;
      return;
    }

    if (top === 0xe0 || top === 0xf0) {
      // Read/write track — not supported
      this.status = ST_NOT_FOUND;
      this.buf = null;
      this.multiLeft = 0;
      return;
    }

    this.status = ST_NOT_FOUND;
    this.buf = null;
    this.multiLeft = 0;
  }

  inStatus(): number {
    return this.status & 0xff;
  }

  outTrack(val: number): void {
    this.track = val & 0xff;
  }

  inTrack(): number {
    return this.track & 0xff;
  }

  outSector(val: number): void {
    this.sector = val & 0xff;
  }

  inSector(): number {
    return this.sector & 0xff;
  }

  outData(val: number): void {
    this.data = val & 0xff;
    if (!this.buf || !this.writing) return;
    if (this.bufPos < this.buf.length) {
      this.buf[this.bufPos++] = this.data;
      if (this.bufPos >= this.buf.length) this.finishSectorOrContinue();
      else this.status = ST_DRQ | ST_BUSY;
    }
  }

  inData(): number {
    if (!this.buf || this.writing) {
      return this.data & 0xff;
    }
    if (this.bufPos < this.buf.length) {
      this.data = this.buf[this.bufPos++]!;
      if (this.bufPos >= this.buf.length) this.finishSectorOrContinue();
      else this.status = ST_DRQ | ST_BUSY;
      return this.data;
    }
    this.status = this.typeIStatus();
    return this.data;
  }

  /**
   * System port OUT (0xFF): bit0 pages TR-DOS; bit1/bit4 side; bits 2–3 drive.
   * Returns whether TR-DOS should be paged after this write.
   */
  outSystem(val: number): boolean {
    const v = val & 0xff;
    this.side = (v >> 4) & 1;
    if (v & 0x02) this.side = 1;
    this.drive = (v >> 2) & 0x03;
    return (v & 0x01) !== 0;
  }

  static isCommandPort(port: number): boolean {
    return (port & 0xff) === 0x1f;
  }
  static isTrackPort(port: number): boolean {
    return (port & 0xff) === 0x3f;
  }
  static isSectorPort(port: number): boolean {
    return (port & 0xff) === 0x5f;
  }
  static isDataPort(port: number): boolean {
    return (port & 0xff) === 0x7f;
  }
  static isSystemPort(port: number): boolean {
    return (port & 0xff) === 0xff;
  }
}

export const BetaStatus = {
  ST_BUSY,
  ST_DRQ,
  ST_TRACK0,
  ST_SEEK_ERR,
  ST_NOT_FOUND,
  ST_HEAD_LOADED,
  ST_WRITE_PROTECT,
  ST_NOT_READY,
};
