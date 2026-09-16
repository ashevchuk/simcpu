/**
 * ZX Spectrum .Z80 snapshot loader (v1 / v2 / v3) for soft 48K + 128K.
 */

import type { SoftZ80State } from '../softZ80.js';
import type { Ay8912 } from './ay8912.js';
import { SpectrumMmu, SPEC_BANK_SIZE } from './mmu.js';
import type { SpectrumUla } from './ula.js';
import type { SpectrumModel } from './mmu.js';

function u16le(buf: Uint8Array, off: number): number {
  return (buf[off]! | (buf[off + 1]! << 8)) & 0xffff;
}

/** Decompress Z80 ED ED xx yy runs into out (max maxLen). */
export function decompressZ80Block(src: Uint8Array, maxLen: number): Uint8Array {
  const out = new Uint8Array(maxLen);
  let si = 0;
  let di = 0;
  while (si < src.length && di < maxLen) {
    if (
      si + 3 < src.length &&
      src[si] === 0xed &&
      src[si + 1] === 0xed
    ) {
      const n = src[si + 2]!;
      const b = src[si + 3]!;
      for (let i = 0; i < n && di < maxLen; i++) out[di++] = b;
      si += 4;
      continue;
    }
    out[di++] = src[si++]!;
  }
  return out.subarray(0, di);
}

export type Z80ApplyResult = {
  pc: number;
  border: number;
  model: SpectrumModel;
  port7ffd: number;
  version: 1 | 2 | 3;
};

function applyHeaderRegs(cpu: SoftZ80State, h: Uint8Array, pc: number): number {
  cpu.a = h[0]!;
  cpu.f = h[1]!;
  cpu.c = h[2]!;
  cpu.b = h[3]!;
  cpu.l = h[4]!;
  cpu.h = h[5]!;
  cpu.sp = u16le(h, 8);
  cpu.i = h[10]!;
  let r = h[11]!;
  const flags = h[12] === 255 ? 1 : h[12]!;
  r = (r & 0x7f) | ((flags & 1) << 7);
  cpu.r = r;
  const border = (flags >> 1) & 7;
  cpu.e = h[13]!;
  cpu.d = h[14]!;
  cpu.c2 = h[15]!;
  cpu.b2 = h[16]!;
  cpu.e2 = h[17]!;
  cpu.d2 = h[18]!;
  cpu.l2 = h[19]!;
  cpu.h2 = h[20]!;
  cpu.a2 = h[21]!;
  cpu.f2 = h[22]!;
  cpu.iy = u16le(h, 23);
  cpu.ix = u16le(h, 25);
  cpu.iff1 = h[27]! !== 0;
  cpu.iff2 = h[28]! !== 0;
  const im = h[29]! & 3;
  cpu.im = im === 2 ? 2 : im === 1 ? 1 : 0;
  cpu.eiDelay = 0;
  cpu.halted = false;
  cpu.pc = pc & 0xffff;
  return border;
}

function is128Hardware(hw: number, ver: 2 | 3, modify: boolean): boolean {
  void modify;
  if (ver === 2) return hw === 3 || hw === 4 || hw >= 7;
  return hw === 4 || hw === 5 || hw === 6 || hw >= 7;
}

/** Peek .Z80 header to choose 48 vs 128 before booting ROM. */
export function peekZ80Model(data: Uint8Array): SpectrumModel {
  if (data.length < 30) throw new Error('Z80 too short');
  const pcWord = data[6]! | (data[7]! << 8);
  if (pcWord !== 0) return '48';
  if (data.length < 35) return '48';
  const addLen = data[30]! | (data[31]! << 8);
  const ver: 2 | 3 = addLen <= 23 ? 2 : 3;
  const hw = data[34]!;
  const modify = addLen >= 7 && data.length > 37 && (data[37]! & 0x80) !== 0;
  return is128Hardware(hw, ver, modify) ? '128' : '48';
}

/**
 * Apply a .Z80 snapshot. Caller should bootSpectrum(mmu, model) first for ROM,
 * or pass model from result after detection — this function configures banks/regs.
 */
export function applyZ80(
  mmu: SpectrumMmu,
  cpu: SoftZ80State,
  ula: SpectrumUla,
  data: Uint8Array,
  ay?: Ay8912 | null,
): Z80ApplyResult {
  if (data.length < 30) throw new Error('Z80 too short');
  const h = data;
  const pcWord = u16le(h, 6);
  const ver: 1 | 2 | 3 = pcWord !== 0 ? 1 : data.length >= 32 ? (u16le(h, 30) <= 23 ? 2 : 3) : 1;

  if (ver === 1) {
    const flags = h[12] === 255 ? 1 : h[12]!;
    const compressed = (flags & 0x20) !== 0;
    const border = applyHeaderRegs(cpu, h, pcWord);
    ula.border = border;
    ula.clearKeys();
    ula.clearIrq();
    const body = data.subarray(30);
    let mem48: Uint8Array;
    if (compressed) {
      // strip end marker 00 ED ED 00 if present
      let end = body.length;
      if (
        end >= 4 &&
        body[end - 4] === 0x00 &&
        body[end - 3] === 0xed &&
        body[end - 2] === 0xed &&
        body[end - 1] === 0x00
      ) {
        end -= 4;
      }
      mem48 = decompressZ80Block(body.subarray(0, end), 0xc000);
      if (mem48.length < 0xc000) {
        const full = new Uint8Array(0xc000);
        full.set(mem48);
        mem48 = full;
      }
    } else {
      if (body.length < 0xc000) throw new Error('Z80 v1 uncompressed too short');
      mem48 = body.subarray(0, 0xc000);
    }
    mmu.banks[5]!.set(mem48.subarray(0, SPEC_BANK_SIZE));
    mmu.banks[2]!.set(mem48.subarray(SPEC_BANK_SIZE, SPEC_BANK_SIZE * 2));
    mmu.banks[0]!.set(mem48.subarray(SPEC_BANK_SIZE * 2));
    mmu.port7ffd = 0x20;
    return { pc: cpu.pc, border, model: '48', port7ffd: 0x20, version: 1 };
  }

  const addLen = u16le(h, 30);
  const headerEnd = 32 + addLen;
  if (data.length < headerEnd) throw new Error('Z80 truncated header');
  const pc = u16le(h, 32);
  const hw = h[34]!;
  const port7ffd = h[35]!;
  const modify = addLen >= 7 && (h[37]! & 0x80) !== 0;
  const use128 = is128Hardware(hw, ver, modify);
  const border = applyHeaderRegs(cpu, h, pc);
  ula.border = border;
  ula.clearKeys();
  ula.clearIrq();

  if (addLen >= 23 && ay) {
    const sel = h[38]!;
    ay.loadRegs(h.subarray(39, 55), sel);
  }

  // Memory pages
  let off = headerEnd;
  const pageToBank48: Record<number, number> = { 8: 5, 4: 2, 5: 0 };
  const pageToBank128: Record<number, number> = {
    3: 0,
    4: 1,
    5: 2,
    6: 3,
    7: 4,
    8: 5,
    9: 6,
    10: 7,
  };

  while (off + 3 <= data.length) {
    const clen = u16le(data, off);
    const page = data[off + 2]!;
    off += 3;
    let block: Uint8Array;
    if (clen === 0xffff) {
      if (off + SPEC_BANK_SIZE > data.length) throw new Error('Z80 page truncated');
      block = data.subarray(off, off + SPEC_BANK_SIZE);
      off += SPEC_BANK_SIZE;
    } else {
      if (off + clen > data.length) throw new Error('Z80 compressed page truncated');
      block = decompressZ80Block(data.subarray(off, off + clen), SPEC_BANK_SIZE);
      off += clen;
      if (block.length < SPEC_BANK_SIZE) {
        const full = new Uint8Array(SPEC_BANK_SIZE);
        full.set(block);
        block = full;
      }
    }
    if (use128) {
      const bank = pageToBank128[page];
      if (bank !== undefined) mmu.banks[bank]!.set(block.subarray(0, SPEC_BANK_SIZE));
    } else {
      const bank = pageToBank48[page];
      if (bank !== undefined) mmu.banks[bank]!.set(block.subarray(0, SPEC_BANK_SIZE));
    }
  }

  if (use128) {
    mmu.port7ffd = 0;
    mmu.out7ffd(port7ffd);
    // Extended header if1: bit0 = TR-DOS ROM paged (disk I/O not emulated)
    mmu.trdosPaged = addLen >= 7 && (h[37]! & 0x01) !== 0;
  } else {
    mmu.port7ffd = 0x20;
    mmu.trdosPaged = false;
  }

  return {
    pc: cpu.pc,
    border,
    model: use128 ? '128' : '48',
    port7ffd: mmu.port7ffd,
    version: ver,
  };
}

function writeU16(out: Uint8Array, off: number, v: number): void {
  out[off] = v & 0xff;
  out[off + 1] = (v >> 8) & 0xff;
}

/** Write v2/v3 base register header (PC word forced to 0). */
function writeZ80BaseHeader(cpu: SoftZ80State, border: number, out: Uint8Array): void {
  out[0] = cpu.a & 0xff;
  out[1] = cpu.f & 0xff;
  out[2] = cpu.c & 0xff;
  out[3] = cpu.b & 0xff;
  out[4] = cpu.l & 0xff;
  out[5] = cpu.h & 0xff;
  writeU16(out, 6, 0); // v2/v3 marker
  writeU16(out, 8, cpu.sp);
  out[10] = cpu.i & 0xff;
  out[11] = cpu.r & 0x7f;
  let flags = ((cpu.r >> 7) & 1) | ((border & 7) << 1);
  out[12] = flags;
  out[13] = cpu.e & 0xff;
  out[14] = cpu.d & 0xff;
  out[15] = cpu.c2 & 0xff;
  out[16] = cpu.b2 & 0xff;
  out[17] = cpu.e2 & 0xff;
  out[18] = cpu.d2 & 0xff;
  out[19] = cpu.l2 & 0xff;
  out[20] = cpu.h2 & 0xff;
  out[21] = cpu.a2 & 0xff;
  out[22] = cpu.f2 & 0xff;
  writeU16(out, 23, cpu.iy);
  writeU16(out, 25, cpu.ix);
  out[27] = cpu.iff1 ? 1 : 0;
  out[28] = cpu.iff2 ? 1 : 0;
  out[29] = cpu.im & 3;
}

function appendUncompressedPage(chunks: Uint8Array[], page: number, bank: Uint8Array): void {
  const hdr = new Uint8Array(3);
  writeU16(hdr, 0, 0xffff);
  hdr[2] = page & 0xff;
  chunks.push(hdr, bank);
}

/**
 * Save current soft Spectrum as .Z80 v3 (uncompressed pages, AY regs for 128).
 */
export function saveZ80(
  mmu: SpectrumMmu,
  cpu: SoftZ80State,
  ula: SpectrumUla,
  ay?: Ay8912 | null,
): Uint8Array {
  const addLen = 54; // v3 without 1FFD byte
  const headerEnd = 32 + addLen;
  const header = new Uint8Array(headerEnd);
  writeZ80BaseHeader(cpu, ula.border, header);
  writeU16(header, 30, addLen);
  writeU16(header, 32, cpu.pc);
  const use128 = mmu.model === '128';
  header[34] = use128 ? 4 : 0; // v3: 0=48k, 4=128k
  header[35] = use128 ? mmu.port7ffd & 0xff : 0;
  header[36] = 0;
  let if1 = 0x04; // AY present bit (harmless on 48)
  if (mmu.trdosPaged) if1 |= 0x01;
  header[37] = if1;
  header[38] = ay ? ay.selected & 0x0f : 0;
  if (ay) header.set(ay.regs.subarray(0, 16), 39);
  // remaining v3 fields stay 0; mark ROM windows as ROM
  header[61] = 0xff;
  header[62] = 0xff;

  const chunks: Uint8Array[] = [header];
  if (use128) {
    // pages 3..10 → banks 0..7
    for (let bank = 0; bank < 8; bank++) {
      appendUncompressedPage(chunks, bank + 3, mmu.banks[bank]!);
    }
  } else {
    appendUncompressedPage(chunks, 8, mmu.banks[5]!);
    appendUncompressedPage(chunks, 4, mmu.banks[2]!);
    appendUncompressedPage(chunks, 5, mmu.banks[0]!);
  }

  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
