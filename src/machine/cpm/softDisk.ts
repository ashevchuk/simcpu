/**
 * Soft CP/M-80 disk: classic single-sided SD geometry (77×26×128).
 * Hosted outside RAM; BIOS READ/WRITE copy sectors to/from DMA in RAM.
 */

export const CPM_SEC_SIZE = 128;
export const CPM_SECS_PER_TRACK = 26;
export const CPM_TRACKS = 77;
export const CPM_DISK_BYTES = CPM_TRACKS * CPM_SECS_PER_TRACK * CPM_SEC_SIZE;

/** BIOS workspace in high RAM (track/sec/dma) — shared with softDevices disk port. */
export const BIOS_WORK = 0xfd00;
export const BIOS_TRACK = BIOS_WORK + 0;
export const BIOS_SECTOR = BIOS_WORK + 1;
export const BIOS_DMA = BIOS_WORK + 2; // word

export class SoftDisk {
  readonly image: Uint8Array;

  constructor(image?: Uint8Array) {
    if (image && image.length >= CPM_DISK_BYTES) {
      this.image = new Uint8Array(image.subarray(0, CPM_DISK_BYTES));
    } else {
      this.image = new Uint8Array(CPM_DISK_BYTES);
      if (image) this.image.set(image);
    }
  }

  private offset(track: number, sector: number): number {
    if (track < 0 || track >= CPM_TRACKS) throw new RangeError(`track ${track}`);
    if (sector < 1 || sector > CPM_SECS_PER_TRACK) throw new RangeError(`sector ${sector}`);
    return (track * CPM_SECS_PER_TRACK + (sector - 1)) * CPM_SEC_SIZE;
  }

  readSector(ram: Uint8Array, track: number, sector: number, dma: number): void {
    const off = this.offset(track, sector);
    for (let i = 0; i < CPM_SEC_SIZE; i++) {
      ram[(dma + i) & 0xffff] = this.image[off + i]!;
    }
  }

  writeSector(ram: Uint8Array, track: number, sector: number, dma: number): void {
    const off = this.offset(track, sector);
    for (let i = 0; i < CPM_SEC_SIZE; i++) {
      this.image[off + i] = ram[(dma + i) & 0xffff]!;
    }
  }
}

export function createSoftDisk(): SoftDisk {
  return new SoftDisk();
}
