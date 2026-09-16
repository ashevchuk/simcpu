/**
 * Soft TR-DOS / Beta Disk stubs: mount a .TRD image and track paging intent.
 *
 * Real WD1793 sector I/O / DivMMC filesystem are NOT emulated — enough for ROM
 * paging flags, snapshot metadata, and UI demos. Titles that need disk reads
 * will not boot beyond TR-DOS BASIC without a fuller Beta implementation.
 */

export const TRD_TRACKS = 80;
export const TRD_SECTORS = 16;
export const TRD_SECTOR_SIZE = 256;
export const TRD_SIDE_SIZE = TRD_TRACKS * TRD_SECTORS * TRD_SECTOR_SIZE; // 327680
export const TRD_DS_SIZE = TRD_SIDE_SIZE * 2; // 655360

export type TrdInfo = {
  bytes: Uint8Array;
  sides: 1 | 2;
  label: string;
};

/** Parse/accept a .TRD image (single or double sided). */
export function parseTrd(data: Uint8Array): TrdInfo {
  if (data.length < TRD_SIDE_SIZE) {
    throw new Error(`TRD too short (${data.length}; want ≥ ${TRD_SIDE_SIZE})`);
  }
  const sides: 1 | 2 = data.length >= TRD_DS_SIZE ? 2 : 1;
  // Disk label at sector 8 of track 0 (offset 0x800), 8 bytes often
  let label = 'DISK';
  const labOff = 0x800;
  if (data.length > labOff + 8) {
    const raw = data.subarray(labOff, labOff + 8);
    const s = Array.from(raw)
      .map((c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : ''))
      .join('')
      .trim();
    if (s) label = s;
  }
  return { bytes: data.slice(), sides, label };
}

/** Build a blank single-sided TRD with TR-DOS empty-disk geometry + label. */
export function buildMinimalTrd(label = 'TESTDISK'): Uint8Array {
  const img = new Uint8Array(TRD_SIDE_SIZE);
  // Directory entries (sectors 1–8): 0x00 = free slot marker for soft tests
  // Disk info at sector 9 (1-based) = offset 8 * 256 = 0x800
  const lab = label.toUpperCase().replace(/[^A-Z0-9 ]/g, '').slice(0, 8).padEnd(8, ' ');
  for (let i = 0; i < 8; i++) img[0x800 + i] = lab.charCodeAt(i);
  // TR-DOS disk type / free sectors (soft-compatible placeholders)
  img[0x8e2] = 0x16; // 80 track DS marker often 0x16; SS empty disks vary — soft OK
  img[0x8e3] = 0x00; // files on disk
  img[0x8e4] = 0xfe; // free sectors lo (approx empty)
  img[0x8e5] = 0x09; // free sectors hi
  img[0x8e6] = 0x10; // TR-DOS id
  img[0x8e7] = 0x00;
  img[0x8e8] = 0x00;
  img[0x8e9] = 0x00;
  img[0x8ea] = 0x00;
  img[0x8eb] = 0x20; // free track
  // Mark sector 1 byte 0 for BetaDisk unit tests
  img[0] = 0xaa;
  return img;
}

/**
 * Soft contended-memory: count accesses and accumulate wait units that drain
 * the soft-run instruction budget (approximate ULA contention, not T-state exact).
 */
export class ContendedStub {
  hits = 0;
  /** Extra soft-ops burned this frame from contended accesses / FE port. */
  waitUnits = 0;
  /** Wait units charged per contended mem access. */
  memCost = 1;
  /** Wait units charged per FE port access. */
  portCost = 2;
  enabled = true;

  reset(): void {
    this.hits = 0;
    this.waitUnits = 0;
  }

  /** Begin a soft frame — clear wait accumulator (hits keep rising for UI). */
  beginFrame(): void {
    this.waitUnits = 0;
  }

  /** Contended if address in $4000–$7FFF (ULA contended) on 48/128. */
  noteAccess(addr: number): void {
    if (!this.enabled) return;
    addr &= 0xffff;
    if (addr >= 0x4000 && addr < 0x8000) {
      this.hits++;
      this.waitUnits += this.memCost;
    }
  }

  noteFePort(): void {
    if (!this.enabled) return;
    this.waitUnits += this.portCost;
  }

  /**
   * Reduce a soft-run instruction budget by waitUnits (keep at least `floor`).
   * Call once after softRun or to compute effective max before run.
   */
  applyToBudget(maxOps: number, floor = 1000): number {
    const reduced = maxOps - this.waitUnits;
    return Math.max(floor, reduced);
  }
}

/**
 * Soft +2A/+3 & DivMMC stub latches (ports acknowledged, no full paging ROM).
 *
 * OUT 1FFD / E3 update visible UI state only — they do not swap ROM/RAM banks
 * like real +2A/+3 or DivMMC hardware. Enough for I/O maps and snapshots.
 */
export class ExpansionStub {
  /** Last OUT to 1FFD (+2A/+3 memory control). */
  port1ffd = 0;
  /** DivMMC: CONMEM / MAPRAM style flags (software-visible stub). */
  divmmcControl = 0;
  divmmcPaged = false;
  /** Model hint for UI. */
  plusModel: 'none' | '+2A' | '+3' = 'none';

  reset(): void {
    this.port1ffd = 0;
    this.divmmcControl = 0;
    this.divmmcPaged = false;
    this.plusModel = 'none';
  }

  /** Port 1FFD (+2A/+3 memory control). */
  static isPort1ffd(port: number): boolean {
    return (port & 0xffff) === 0x1ffd;
  }

  /** DivMMC control often at 0xE3. */
  static isDivmmcPort(port: number): boolean {
    return (port & 0xff) === 0xe3;
  }

  out1ffd(val: number): void {
    this.port1ffd = val & 0xff;
    if (this.plusModel === 'none') this.plusModel = '+2A';
  }

  outDivmmc(val: number): void {
    this.divmmcControl = val & 0xff;
    this.divmmcPaged = (val & 0x80) !== 0 || (val & 0x40) !== 0;
  }
}
