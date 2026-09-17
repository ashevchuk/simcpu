/**
 * Soft ZX Spectrum 128 memory map: 8×16K RAM banks + 2×16K ROM + port 7FFD.
 * Also drives 48K mode (ROM0 = 48K BASIC, paging locked with bank 0 at $C000).
 */

export const SPEC_BANK_SIZE = 0x4000;
export const SPEC_BANK_COUNT = 8;

export type SpectrumModel = '48' | '128';

export class SpectrumMmu {
  readonly banks: Uint8Array[] = Array.from(
    { length: SPEC_BANK_COUNT },
    () => new Uint8Array(SPEC_BANK_SIZE),
  );
  /** ROM 0 = 128 editor (or 48K BASIC in 48 mode); ROM 1 = 48 BASIC on 128. */
  rom0 = new Uint8Array(SPEC_BANK_SIZE);
  rom1 = new Uint8Array(SPEC_BANK_SIZE);
  /** TR-DOS ROM (16K) when Beta Disk pages DOS. */
  trdosRom = new Uint8Array(SPEC_BANK_SIZE);
  /** Last OUT to port 7FFD (bits: 0–2 bank, 3 shadow screen, 4 ROM, 5 lock). */
  port7ffd = 0;
  model: SpectrumModel = '48';
  /** TR-DOS ROM paged at $0000–$3FFF (Beta Disk). */
  trdosPaged = false;

  /** Install TR-DOS ROM image (call once at boot / attach). */
  setTrdosRom(rom: Uint8Array): void {
    if (rom.length !== SPEC_BANK_SIZE) throw new Error('TR-DOS ROM must be 16KiB');
    this.trdosRom.set(rom);
  }

  resetBanks(): void {
    for (const b of this.banks) b.fill(0);
  }

  /** 48K: single ROM in rom0, paging locked, bank 0 at $C000. */
  configure48(rom48: Uint8Array): void {
    this.model = '48';
    if (rom48.length !== SPEC_BANK_SIZE) throw new Error('48K ROM must be 16KiB');
    this.rom0.set(rom48);
    this.rom1.fill(0xff);
    this.port7ffd = 0x20; // locked, bank 0, ROM0
  }

  /** 128K: 32KiB ROM (editor + 48 BASIC), paging enabled, bank 0 at $C000. */
  configure128(rom128: Uint8Array): void {
    this.model = '128';
    if (rom128.length !== SPEC_BANK_SIZE * 2) throw new Error('128K ROM must be 32KiB');
    this.rom0.set(rom128.subarray(0, SPEC_BANK_SIZE));
    this.rom1.set(rom128.subarray(SPEC_BANK_SIZE));
    this.port7ffd = 0;
  }

  get pagedBank(): number {
    return this.port7ffd & 7;
  }

  get romSelect(): number {
    return (this.port7ffd >> 4) & 1;
  }

  get pagingLocked(): boolean {
    return (this.port7ffd & 0x20) !== 0;
  }

  /** Screen file bank: 7 if bit3 set, else 5. */
  displayBankIndex(): number {
    return (this.port7ffd & 0x08) !== 0 ? 7 : 5;
  }

  displayBank(): Uint8Array {
    return this.banks[this.displayBankIndex()]!;
  }

  out7ffd(val: number): void {
    if (this.pagingLocked) return;
    this.port7ffd = val & 0xff;
  }

  /** True if port decode matches Spectrum 128 memory port (A15=0, A1=0). */
  static isPort7ffd(port: number): boolean {
    return (port & 0x8002) === 0;
  }

  read(addr: number): number {
    addr &= 0xffff;
    if (addr < 0x4000) {
      if (this.trdosPaged) return this.trdosRom[addr]!;
      const rom = this.romSelect === 0 ? this.rom0 : this.rom1;
      return rom[addr]!;
    }
    if (addr < 0x8000) return this.banks[5]![addr - 0x4000]!;
    if (addr < 0xc000) return this.banks[2]![addr - 0x8000]!;
    return this.banks[this.pagedBank]![addr - 0xc000]!;
  }

  write(addr: number, v: number): void {
    addr &= 0xffff;
    v &= 0xff;
    if (addr < 0x4000) return; // ROM
    if (addr < 0x8000) {
      this.banks[5]![addr - 0x4000] = v;
      return;
    }
    if (addr < 0xc000) {
      this.banks[2]![addr - 0x8000] = v;
      return;
    }
    this.banks[this.pagedBank]![addr - 0xc000] = v;
  }

  /**
   * Copy the currently visible 48K window ($4000–$FFFF) into a flat 64K buffer
   * for callers that still expect ram.bytes layout (ROM left alone).
   */
  syncVisibleRam(ram: Uint8Array): void {
    if (ram.length < 0x10000) return;
    for (let a = 0x4000; a < 0x10000; a++) ram[a] = this.read(a);
  }
}
