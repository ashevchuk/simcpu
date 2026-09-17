/**
 * ZX Spectrum .TAP tape image: length-prefixed blocks for flash-load via LD-BYTES trap.
 */

import type { SoftZ80State } from '../softZ80.js';

const FLAG_C = 0x01;
const FLAG_Z = 0x40;

/** One TAP block: flag byte + payload (checksum stripped). */
export interface TapBlock {
  flag: number;
  data: Uint8Array;
}

/** Parse a .TAP file into blocks. Throws on truncated/corrupt length. */
export function parseTap(bytes: Uint8Array): TapBlock[] {
  const out: TapBlock[] = [];
  let i = 0;
  while (i + 2 <= bytes.length) {
    const len = bytes[i]! | (bytes[i + 1]! << 8);
    i += 2;
    if (len < 2) throw new Error(`TAP block too short (len=${len}) at offset ${i - 2}`);
    if (i + len > bytes.length) throw new Error(`TAP truncated at offset ${i - 2}`);
    const chunk = bytes.subarray(i, i + len);
    i += len;
    const flag = chunk[0]!;
    // last byte is XOR checksum of flag+data
    const data = chunk.subarray(1, len - 1);
    let sum = flag;
    for (let k = 0; k < data.length; k++) sum ^= data[k]!;
    sum ^= chunk[len - 1]!;
    if (sum !== 0) {
      // Soft: warn via throw only for empty; many dumps have bad checksums — still load.
      // Keep data; checksum mismatch is non-fatal for flash-load.
    }
    out.push({ flag, data: data.slice() });
  }
  if (i !== bytes.length) throw new Error(`TAP trailing ${bytes.length - i} byte(s)`);
  return out;
}

/** Sequential TAP deck for Spectrum LOAD "" flash-load. */
export class SpectrumTape {
  readonly blocks: TapBlock[];
  pos = 0;

  constructor(blocks: TapBlock[]) {
    this.blocks = blocks;
  }

  static fromBytes(bytes: Uint8Array): SpectrumTape {
    return new SpectrumTape(parseTap(bytes));
  }

  get remaining(): number {
    return Math.max(0, this.blocks.length - this.pos);
  }

  reset(): void {
    this.pos = 0;
  }

  /** Seek to block index (0 = start). */
  seek(index: number): void {
    this.pos = Math.max(0, Math.min(this.blocks.length, index | 0));
  }

  /** Advance one block without matching flag (manual tape browser). */
  next(): void {
    if (this.pos < this.blocks.length) this.pos++;
  }

  /**
   * Next block whose flag matches `flag`. Advances past skipped blocks and the match.
   * Returns null if none left.
   */
  takeFlag(flag: number): TapBlock | null {
    while (this.pos < this.blocks.length) {
      const b = this.blocks[this.pos]!;
      this.pos++;
      if ((b.flag & 0xff) === (flag & 0xff)) return b;
    }
    return null;
  }
}

/** Human-readable label for a TAP/TZX flash-load block. */
export function describeTapBlock(block: TapBlock, index: number): string {
  const flag = block.flag & 0xff;
  const n = block.data.length;
  if (flag === 0x00 && n >= 17) {
    const typ = block.data[0]!;
    const nameBytes = block.data.subarray(1, 11);
    let name = '';
    for (let i = 0; i < nameBytes.length; i++) {
      const c = nameBytes[i]!;
      if (c >= 0x20 && c < 0x7f) name += String.fromCharCode(c);
    }
    name = name.trim() || '?';
    const kind = typ === 0 ? 'PROG' : typ === 1 ? 'NUM' : typ === 2 ? 'CHAR' : typ === 3 ? 'CODE' : `T${typ}`;
    return `#${index} HDR ${kind} "${name}" (${n}B)`;
  }
  if (flag === 0xff) return `#${index} DATA (${n}B)`;
  return `#${index} flag=${flag.toString(16)} (${n}B)`;
}

/**
 * Flash-load trap for ROM LD-BYTES ($0556).
 * On completion: sets flags/IX/DE, enables interrupts (as SA_LD_RET does), then
 * RETs to the CALLER. Real LD-BYTES RETs into SA_LD_RET ($053F) which EI's —
 * skipping that left IFF=0 so BASIC `PAUSE` deadlocked on HALT (ParaZXland).
 * We EI+RET directly instead of jumping to $053F so a held Space (or residual
 * key from typing LOAD "") cannot trip SA_LD_RET's BREAK check mid flash-load.
 *
 * Optional `mem` routes reads/writes through the Spectrum MMU (required in soft 128).
 */
export function trapLdBytes(
  cpu: SoftZ80State,
  ram: Uint8Array,
  tape: SpectrumTape,
  mem?: {
    read: (addr: number) => number;
    write: (addr: number, v: number) => void;
    setBorder?: (border: number) => void;
  },
): boolean {
  if (cpu.pc !== 0x0556) return false;

  const read = (addr: number) => (mem ? mem.read(addr) : ram[addr & 0xffff]!) & 0xff;
  const write = (addr: number, v: number) => {
    if (mem) mem.write(addr, v);
    else ram[addr & 0xffff] = v & 0xff;
  };

  const flag = cpu.a & 0xff;
  const doLoad = (cpu.f & FLAG_C) !== 0;
  let left = ((cpu.d << 8) | cpu.e) & 0xffff;
  let addr = cpu.ix & 0xffff;

  /** Match SA_LD_RET: EI then RET to caller (skip BREAK abort). */
  const finish = (): void => {
    cpu.halted = false;
    cpu.iff1 = true;
    cpu.iff2 = true;
    cpu.eiDelay = 1;
    // Restore border colour from BORDCR like SA_LD_RET
    const bordcr = read(0x5c48);
    const border = (bordcr >> 3) & 7;
    mem?.setBorder?.(border);
    returnRet(cpu, read);
  };

  if (tape.remaining <= 0) {
    cpu.f = (cpu.f & ~FLAG_C) | FLAG_Z;
    finish();
    return true;
  }

  const block = tape.takeFlag(flag);
  if (!block) {
    cpu.f = (cpu.f & ~FLAG_C) | FLAG_Z;
    finish();
    return true;
  }

  if (block.data.length < left) {
    cpu.f = (cpu.f & ~FLAG_C) | FLAG_Z;
    finish();
    return true;
  }

  for (let n = 0; n < left; n++) {
    const v = block.data[n]!;
    if (doLoad) {
      if (addr >= 0x4000) write(addr, v);
    } else if (read(addr) !== v) {
      cpu.f = (cpu.f & ~FLAG_C) | FLAG_Z;
      cpu.ix = (addr + n) & 0xffff;
      cpu.d = ((left - n) >> 8) & 0xff;
      cpu.e = (left - n) & 0xff;
      finish();
      return true;
    }
    addr = (addr + 1) & 0xffff;
  }

  cpu.ix = addr;
  cpu.d = 0;
  cpu.e = 0;
  cpu.f = (cpu.f | FLAG_C) & ~FLAG_Z;
  finish();
  return true;
}

function returnRet(cpu: SoftZ80State, read: (addr: number) => number): void {
  const lo = read(cpu.sp & 0xffff);
  const hi = read((cpu.sp + 1) & 0xffff);
  cpu.sp = (cpu.sp + 2) & 0xffff;
  cpu.pc = (lo | (hi << 8)) & 0xffff;
}

/** Build a minimal TAP (header + data) for tests — CODE block at `addr`. */
export function buildCodeTap(name: string, addr: number, payload: Uint8Array): Uint8Array {
  const nm = new Uint8Array(10);
  nm.fill(0x20);
  const enc = new TextEncoder().encode(name.slice(0, 10));
  nm.set(enc);

  const headerData = new Uint8Array(17);
  headerData[0] = 3; // CODE
  headerData.set(nm, 1);
  headerData[11] = payload.length & 0xff;
  headerData[12] = (payload.length >> 8) & 0xff;
  headerData[13] = addr & 0xff;
  headerData[14] = (addr >> 8) & 0xff;
  headerData[15] = 0;
  headerData[16] = 0x80;

  return concatTapBlocks([
    makeTapBlock(0x00, headerData),
    makeTapBlock(0xff, payload),
  ]);
}

export function makeTapBlock(flag: number, data: Uint8Array): Uint8Array {
  let sum = flag & 0xff;
  for (let i = 0; i < data.length; i++) sum ^= data[i]!;
  const chunk = new Uint8Array(1 + data.length + 1);
  chunk[0] = flag & 0xff;
  chunk.set(data, 1);
  chunk[chunk.length - 1] = sum & 0xff;
  const out = new Uint8Array(2 + chunk.length);
  out[0] = chunk.length & 0xff;
  out[1] = (chunk.length >> 8) & 0xff;
  out.set(chunk, 2);
  return out;
}

function concatTapBlocks(blocks: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const b of blocks) n += b.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const b of blocks) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}
