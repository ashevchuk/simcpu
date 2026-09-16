/**
 * Soft CP/M-80 filesystem on SoftDisk (IBM 3740 SS SD geometry).
 *
 * Layout (standard 8" SS SD):
 *   tracks 0–1   reserved (system)
 *   track 2+     directory then data
 *   block size   1 KiB (8 × 128-byte sectors)
 *   directory    64 entries × 32 bytes = 2 blocks
 *   DSM          242 (blocks 0..242; 0–1 = directory)
 */

import {
  CPM_SEC_SIZE,
  CPM_SECS_PER_TRACK,
  SoftDisk,
} from './softDisk.js';
import { CPM_TPA } from '../memoryMap.js';

export const CPM_DIR_TRACK = 2;
export const CPM_BLOCK_SECS = 8;
export const CPM_BLOCK_SIZE = CPM_BLOCK_SECS * CPM_SEC_SIZE; // 1024
export const CPM_DIR_ENTRIES = 64;
export const CPM_DIR_ENTRY_SIZE = 32;
export const CPM_DSM = 242;
export const CPM_EXTENT_BLOCKS = 16; // 16 × 1K = 16 KiB per extent

export interface CpmDirEntry {
  user: number; // 0xE5 = deleted/empty
  name: string; // 8 chars padded
  ext: string; // 3 chars padded
  extent: number; // EX
  s1: number;
  s2: number;
  rc: number; // record count in this extent (0–128)
  alloc: number[]; // 16 block numbers (0 = unused)
  index: number; // directory slot 0..63
}

function padName(s: string, len: number): string {
  const u = s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, len);
  return u.padEnd(len, ' ');
}

export function parseFilename(spec: string): { name: string; ext: string } {
  const t = spec.trim().toUpperCase().replace(/^\d+:/, '');
  const dot = t.indexOf('.');
  if (dot < 0) return { name: padName(t, 8), ext: padName('', 3) };
  return { name: padName(t.slice(0, dot), 8), ext: padName(t.slice(dot + 1), 3) };
}

export function formatFilename(name: string, ext: string): string {
  const n = name.trimEnd();
  const e = ext.trimEnd();
  return e ? `${n}.${e}` : n;
}

function matchWild(pat: string, val: string): boolean {
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i]!;
    if (p === '?') continue;
    if (p !== (val[i] ?? ' ')) return false;
  }
  return true;
}

export class CpmFileSystem {
  constructor(readonly disk: SoftDisk) {}

  /** Absolute byte offset of allocation block `blk` on the disk image. */
  blockOffset(blk: number): number {
    // Block 0 starts at directory track (track 2, sector 1).
    const sectorIndex = CPM_DIR_TRACK * CPM_SECS_PER_TRACK + blk * CPM_BLOCK_SECS;
    return sectorIndex * CPM_SEC_SIZE;
  }

  readBlock(blk: number): Uint8Array {
    const out = new Uint8Array(CPM_BLOCK_SIZE);
    const off = this.blockOffset(blk);
    out.set(this.disk.image.subarray(off, off + CPM_BLOCK_SIZE));
    return out;
  }

  writeBlock(blk: number, data: Uint8Array): void {
    const off = this.blockOffset(blk);
    this.disk.image.set(data.subarray(0, CPM_BLOCK_SIZE), off);
  }

  readDirEntry(index: number): CpmDirEntry {
    if (index < 0 || index >= CPM_DIR_ENTRIES) throw new RangeError('dir index');
    const dir = this.readBlock(0);
    // entries 0..31 in block 0, 32..63 in block 1
    const blk = index < 32 ? 0 : 1;
    const data = blk === 0 ? dir : this.readBlock(1);
    const base = (index % 32) * CPM_DIR_ENTRY_SIZE;
    const user = data[base]!;
    let name = '';
    let ext = '';
    for (let i = 0; i < 8; i++) name += String.fromCharCode(data[base + 1 + i]! & 0x7f);
    for (let i = 0; i < 3; i++) ext += String.fromCharCode(data[base + 9 + i]! & 0x7f);
    const alloc: number[] = [];
    for (let i = 0; i < CPM_EXTENT_BLOCKS; i++) alloc.push(data[base + 16 + i]!);
    return {
      user,
      name,
      ext,
      extent: data[base + 12]!,
      s1: data[base + 13]!,
      s2: data[base + 14]!,
      rc: data[base + 15]!,
      alloc,
      index,
    };
  }

  writeDirEntry(e: CpmDirEntry): void {
    const blk = e.index < 32 ? 0 : 1;
    const data = this.readBlock(blk);
    const base = (e.index % 32) * CPM_DIR_ENTRY_SIZE;
    data[base] = e.user & 0xff;
    for (let i = 0; i < 8; i++) data[base + 1 + i] = (e.name.charCodeAt(i) || 0x20) & 0x7f;
    for (let i = 0; i < 3; i++) data[base + 9 + i] = (e.ext.charCodeAt(i) || 0x20) & 0x7f;
    data[base + 12] = e.extent & 0xff;
    data[base + 13] = e.s1 & 0xff;
    data[base + 14] = e.s2 & 0xff;
    data[base + 15] = e.rc & 0xff;
    for (let i = 0; i < CPM_EXTENT_BLOCKS; i++) data[base + 16 + i] = (e.alloc[i] ?? 0) & 0xff;
    this.writeBlock(blk, data);
  }

  /** Empty/deleted directory slots and zero data area. */
  format(): void {
    this.disk.image.fill(0xe5, this.blockOffset(0), this.blockOffset(2));
    this.disk.image.fill(0, this.blockOffset(2));
  }

  list(user = 0, namePat = '????????', extPat = '???'): CpmDirEntry[] {
    const keys = new Set<string>();
    const uniq: CpmDirEntry[] = [];
    for (let i = 0; i < CPM_DIR_ENTRIES; i++) {
      const e = this.readDirEntry(i);
      if (e.user === 0xe5 || e.user !== user) continue;
      if (e.extent !== 0 || e.s2 !== 0) continue; // first extent only for DIR
      if (!matchWild(namePat, e.name) || !matchWild(extPat, e.ext)) continue;
      const key = `${e.name}.${e.ext}`;
      if (keys.has(key)) continue;
      keys.add(key);
      uniq.push(e);
    }
    return uniq.sort((a, b) =>
      formatFilename(a.name, a.ext).localeCompare(formatFilename(b.name, b.ext)),
    );
  }

  private findEntries(user: number, name: string, ext: string): CpmDirEntry[] {
    const out: CpmDirEntry[] = [];
    for (let i = 0; i < CPM_DIR_ENTRIES; i++) {
      const e = this.readDirEntry(i);
      if (e.user !== user) continue;
      if (e.name !== name || e.ext !== ext) continue;
      out.push(e);
    }
    return out.sort((a, b) => a.extent - b.extent || a.s2 - b.s2);
  }

  private allocBitmap(): boolean[] {
    const used = new Array<boolean>(CPM_DSM + 1).fill(false);
    used[0] = true;
    used[1] = true;
    for (let i = 0; i < CPM_DIR_ENTRIES; i++) {
      const e = this.readDirEntry(i);
      if (e.user === 0xe5) continue;
      for (const b of e.alloc) {
        if (b > 0 && b <= CPM_DSM) used[b] = true;
      }
    }
    return used;
  }

  private allocBlock(): number {
    const used = this.allocBitmap();
    for (let b = 2; b <= CPM_DSM; b++) {
      if (!used[b]) return b;
    }
    throw new Error('disk full');
  }

  private freeSlot(): number {
    for (let i = 0; i < CPM_DIR_ENTRIES; i++) {
      if (this.readDirEntry(i).user === 0xe5) return i;
    }
    throw new Error('directory full');
  }

  /** Read entire file contents (all extents). */
  readFile(filename: string, user = 0): Uint8Array | null {
    const { name, ext } = parseFilename(filename);
    const entries = this.findEntries(user, name, ext);
    if (entries.length === 0) return null;
    const chunks: number[] = [];
    for (const e of entries) {
      const records = e.rc & 0x7f;
      let left = records * CPM_SEC_SIZE;
      for (const blk of e.alloc) {
        if (blk === 0 || left <= 0) break;
        const data = this.readBlock(blk);
        const n = Math.min(left, CPM_BLOCK_SIZE);
        for (let i = 0; i < n; i++) chunks.push(data[i]!);
        left -= n;
      }
    }
    return Uint8Array.from(chunks);
  }

  /** Create/overwrite a file from bytes. */
  writeFile(filename: string, data: Uint8Array, user = 0): void {
    const { name, ext } = parseFilename(filename);
    this.deleteFile(filename, user);
    let offset = 0;
    let extent = 0;
    while (offset < data.length || extent === 0) {
      const slot = this.freeSlot();
      const alloc: number[] = new Array(CPM_EXTENT_BLOCKS).fill(0);
      let recs = 0;
      for (let i = 0; i < CPM_EXTENT_BLOCKS && offset < data.length; i++) {
        const blk = this.allocBlock();
        alloc[i] = blk;
        const buf = new Uint8Array(CPM_BLOCK_SIZE);
        const n = Math.min(CPM_BLOCK_SIZE, data.length - offset);
        buf.set(data.subarray(offset, offset + n));
        this.writeBlock(blk, buf);
        offset += n;
        recs += Math.ceil(n / CPM_SEC_SIZE);
      }
      if (data.length === 0 && extent === 0) recs = 0;
      this.writeDirEntry({
        user,
        name,
        ext,
        extent: extent & 0x1f,
        s1: 0,
        s2: (extent >> 5) & 0xff,
        rc: recs & 0x7f,
        alloc,
        index: slot,
      });
      extent++;
      if (offset >= data.length) break;
    }
  }

  deleteFile(filename: string, user = 0): boolean {
    const { name, ext } = parseFilename(filename);
    let found = false;
    for (let i = 0; i < CPM_DIR_ENTRIES; i++) {
      const e = this.readDirEntry(i);
      if (e.user !== user) continue;
      if (e.name !== name || e.ext !== ext) continue;
      e.user = 0xe5;
      this.writeDirEntry(e);
      found = true;
    }
    return found;
  }

  renameFile(oldName: string, newName: string, user = 0): boolean {
    const a = parseFilename(oldName);
    const b = parseFilename(newName);
    let found = false;
    for (let i = 0; i < CPM_DIR_ENTRIES; i++) {
      const e = this.readDirEntry(i);
      if (e.user !== user) continue;
      if (e.name !== a.name || e.ext !== a.ext) continue;
      e.name = b.name;
      e.ext = b.ext;
      this.writeDirEntry(e);
      found = true;
    }
    return found;
  }

  fileExists(filename: string, user = 0): boolean {
    const { name, ext } = parseFilename(filename);
    return this.findEntries(user, name, ext).length > 0;
  }
}

/** Build HELLO.COM: print message via BDOS #9 then JP 0 (WBOOT). */
export function buildHelloCom(): Uint8Array {
  const msg = 'HELLO FROM DISK\r\n$';
  const msgAddr = CPM_TPA + 0x10;
  const out: number[] = [];
  // ORG 0100h
  out.push(0x11, msgAddr & 0xff, (msgAddr >> 8) & 0xff); // LD DE,msg
  out.push(0x0e, 0x09); // LD C,9
  out.push(0xcd, 0x05, 0x00); // CALL 5
  out.push(0xc3, 0x00, 0x00); // JP 0
  while (out.length < 0x10) out.push(0x00);
  for (let i = 0; i < msg.length; i++) out.push(msg.charCodeAt(i) & 0xff);
  return Uint8Array.from(out);
}

/** Build a tiny TYPE-style demo text file. */
export function buildReadmeTxt(): Uint8Array {
  const text =
    'Soft CP/M disk ready.\r\n' +
    'Commands: DIR TYPE ERA REN\r\n' +
    'Run HELLO to load HELLO.COM\r\n';
  return new TextEncoder().encode(text);
}

/** Format disk and seed README.TXT + HELLO.COM. */
export function formatAndSeedDisk(disk: SoftDisk): CpmFileSystem {
  const fs = new CpmFileSystem(disk);
  fs.format();
  fs.writeFile('README.TXT', buildReadmeTxt());
  fs.writeFile('HELLO.COM', buildHelloCom());
  return fs;
}
