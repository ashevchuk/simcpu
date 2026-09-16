/**
 * ZX Spectrum .SNA snapshot loader (48K + 128K).
 *
 * 48K: 27-byte header + 48K RAM; PC on stack (RETN).
 * 128K: same prefix + PC/7FFD/TR-DOS + remaining banks (PC in footer, not stack).
 */

import type { SoftZ80State } from '../softZ80.js';
import { SpectrumMmu, SPEC_BANK_SIZE } from './mmu.js';
import type { SpectrumUla } from './ula.js';

export const SNA_48K_HEADER = 27;
export const SNA_48K_RAM = 0xc000;
export const SNA_48K_SIZE = SNA_48K_HEADER + SNA_48K_RAM; // 49179
/** 128K SNA: 48K image + 4-byte footer + 5×16K remaining banks. */
export const SNA_128K_SIZE = SNA_48K_SIZE + 4 + 5 * SPEC_BANK_SIZE; // 131103
/** Rare variant with 6 remaining banks. */
export const SNA_128K_SIZE_ALT = SNA_48K_SIZE + 4 + 6 * SPEC_BANK_SIZE; // 147487

function u16le(buf: Uint8Array, off: number): number {
  return (buf[off]! | (buf[off + 1]! << 8)) & 0xffff;
}

export function isSna48(data: Uint8Array): boolean {
  return data.length === SNA_48K_SIZE;
}

export function isSna128(data: Uint8Array): boolean {
  return data.length === SNA_128K_SIZE || data.length === SNA_128K_SIZE_ALT;
}

export type SnaApplyResult = {
  pc: number;
  border: number;
  model: '48' | '128';
  port7ffd: number;
};

/** Apply 27-byte SNA register header into soft CPU (does not set PC). */
function applySnaRegs(cpu: SoftZ80State, sna: Uint8Array): void {
  cpu.i = sna[0]!;
  cpu.l2 = sna[1]!;
  cpu.h2 = sna[2]!;
  cpu.e2 = sna[3]!;
  cpu.d2 = sna[4]!;
  cpu.c2 = sna[5]!;
  cpu.b2 = sna[6]!;
  cpu.f2 = sna[7]!;
  cpu.a2 = sna[8]!;
  cpu.l = sna[9]!;
  cpu.h = sna[10]!;
  cpu.e = sna[11]!;
  cpu.d = sna[12]!;
  cpu.c = sna[13]!;
  cpu.b = sna[14]!;
  cpu.iy = u16le(sna, 15);
  cpu.ix = u16le(sna, 17);
  const iffByte = sna[19]!;
  cpu.iff2 = (iffByte & 0x04) !== 0;
  cpu.iff1 = cpu.iff2;
  cpu.r = sna[20]!;
  cpu.f = sna[21]!;
  cpu.a = sna[22]!;
  cpu.sp = u16le(sna, 23);
  const im = sna[25]! & 3;
  cpu.im = im === 2 ? 2 : im === 1 ? 1 : 0;
  cpu.eiDelay = 0;
  cpu.halted = false;
}

/**
 * Apply a 48K .SNA into MMU banks 5/2/0 + soft CPU + ULA.
 * Resumes via RETN-style pop of PC from the stack in bank 0 / visible map.
 */
export function applySna48(
  mmu: SpectrumMmu,
  cpu: SoftZ80State,
  ula: SpectrumUla,
  sna: Uint8Array,
): SnaApplyResult {
  if (!isSna48(sna)) {
    throw new Error(
      `unsupported SNA size ${sna.length} (want ${SNA_48K_SIZE} for 48K)`,
    );
  }

  // 48K image: bank5 @4000, bank2 @8000, bank0 @C000
  const img = sna.subarray(SNA_48K_HEADER, SNA_48K_HEADER + SNA_48K_RAM);
  mmu.banks[5]!.set(img.subarray(0, SPEC_BANK_SIZE));
  mmu.banks[2]!.set(img.subarray(SPEC_BANK_SIZE, SPEC_BANK_SIZE * 2));
  mmu.banks[0]!.set(img.subarray(SPEC_BANK_SIZE * 2, SPEC_BANK_SIZE * 3));
  // Clear other banks
  for (const i of [1, 3, 4, 6, 7]) mmu.banks[i]!.fill(0);

  applySnaRegs(cpu, sna);
  // 48K mode: lock paging with bank 0 at C000
  mmu.port7ffd = 0x20;

  const border = sna[26]! & 7;
  ula.border = border;
  ula.clearKeys();
  ula.clearIrq();

  const pc = mmu.read(cpu.sp) | (mmu.read((cpu.sp + 1) & 0xffff) << 8);
  cpu.sp = (cpu.sp + 2) & 0xffff;
  cpu.pc = pc & 0xffff;

  return { pc: cpu.pc, border, model: '48', port7ffd: mmu.port7ffd };
}

/**
 * Apply a 128K .SNA. PC comes from the footer (not the stack).
 * TR-DOS flag is ignored.
 */
export function applySna128(
  mmu: SpectrumMmu,
  cpu: SoftZ80State,
  ula: SpectrumUla,
  sna: Uint8Array,
): SnaApplyResult {
  if (!isSna128(sna)) {
    throw new Error(
      `unsupported SNA size ${sna.length} (want ${SNA_128K_SIZE} or ${SNA_128K_SIZE_ALT} for 128K)`,
    );
  }

  const footer = SNA_48K_SIZE;
  const pc = u16le(sna, footer);
  const port7ffd = sna[footer + 2]!;
  const trdos = sna[footer + 3]! !== 0;
  const n = port7ffd & 7;

  const img = sna.subarray(SNA_48K_HEADER, SNA_48K_HEADER + SNA_48K_RAM);
  mmu.banks[5]!.set(img.subarray(0, SPEC_BANK_SIZE));
  mmu.banks[2]!.set(img.subarray(SPEC_BANK_SIZE, SPEC_BANK_SIZE * 2));
  mmu.banks[n]!.set(img.subarray(SPEC_BANK_SIZE * 2, SPEC_BANK_SIZE * 3));

  let off = footer + 4;
  const remaining: number[] = [];
  for (let i = 0; i < 8; i++) {
    if (i === 5 || i === 2 || i === n) continue;
    remaining.push(i);
  }
  const extraBanks = sna.length === SNA_128K_SIZE_ALT ? 6 : 5;
  for (let i = 0; i < extraBanks && i < remaining.length; i++) {
    const bank = remaining[i]!;
    mmu.banks[bank]!.set(sna.subarray(off, off + SPEC_BANK_SIZE));
    off += SPEC_BANK_SIZE;
  }
  // Zero any bank not loaded (when n duplicates 5 or 2, remaining has an extra slot)
  for (let i = remaining.length; i < extraBanks; i++) {
    /* alt size may include a duplicate — skip */
  }

  applySnaRegs(cpu, sna);
  // Apply 7FFD after regs — unlock first so out7ffd works
  mmu.port7ffd = 0;
  mmu.out7ffd(port7ffd);
  mmu.trdosPaged = trdos;

  const border = sna[26]! & 7;
  ula.border = border;
  ula.clearKeys();
  ula.clearIrq();

  cpu.pc = pc & 0xffff;

  return { pc: cpu.pc, border, model: '128', port7ffd: mmu.port7ffd };
}

/** Dispatch 48K / 128K SNA. Caller must configure MMU ROM for the target model first. */
export function applySna(
  mmu: SpectrumMmu,
  cpu: SoftZ80State,
  ula: SpectrumUla,
  sna: Uint8Array,
): SnaApplyResult {
  if (isSna48(sna)) return applySna48(mmu, cpu, ula, sna);
  if (isSna128(sna)) return applySna128(mmu, cpu, ula, sna);
  throw new Error(
    `unsupported SNA size ${sna.length} (48K=${SNA_48K_SIZE}, 128K=${SNA_128K_SIZE}|${SNA_128K_SIZE_ALT})`,
  );
}

/** Build 27-byte SNA register header from soft CPU (+ border). PC not stored. */
function writeSnaRegs(cpu: SoftZ80State, border: number, out: Uint8Array, off = 0): void {
  out[off] = cpu.i & 0xff;
  out[off + 1] = cpu.l2 & 0xff;
  out[off + 2] = cpu.h2 & 0xff;
  out[off + 3] = cpu.e2 & 0xff;
  out[off + 4] = cpu.d2 & 0xff;
  out[off + 5] = cpu.c2 & 0xff;
  out[off + 6] = cpu.b2 & 0xff;
  out[off + 7] = cpu.f2 & 0xff;
  out[off + 8] = cpu.a2 & 0xff;
  out[off + 9] = cpu.l & 0xff;
  out[off + 10] = cpu.h & 0xff;
  out[off + 11] = cpu.e & 0xff;
  out[off + 12] = cpu.d & 0xff;
  out[off + 13] = cpu.c & 0xff;
  out[off + 14] = cpu.b & 0xff;
  out[off + 15] = cpu.iy & 0xff;
  out[off + 16] = (cpu.iy >> 8) & 0xff;
  out[off + 17] = cpu.ix & 0xff;
  out[off + 18] = (cpu.ix >> 8) & 0xff;
  out[off + 19] = cpu.iff2 ? 0x04 : 0;
  out[off + 20] = cpu.r & 0xff;
  out[off + 21] = cpu.f & 0xff;
  out[off + 22] = cpu.a & 0xff;
  out[off + 23] = cpu.sp & 0xff;
  out[off + 24] = (cpu.sp >> 8) & 0xff;
  out[off + 25] = cpu.im & 3;
  out[off + 26] = border & 7;
}

/**
 * Save current soft machine as 48K SNA (pushes PC onto stack like Microdrive).
 */
export function saveSna48(mmu: SpectrumMmu, cpu: SoftZ80State, ula: SpectrumUla): Uint8Array {
  const out = new Uint8Array(SNA_48K_SIZE);
  const sp = (cpu.sp - 2) & 0xffff;
  const pc = cpu.pc & 0xffff;
  const savedSp = cpu.sp;
  cpu.sp = sp;
  writeSnaRegs(cpu, ula.border, out, 0);
  cpu.sp = savedSp;
  out.set(mmu.banks[5]!, 27);
  out.set(mmu.banks[2]!, 27 + SPEC_BANK_SIZE);
  out.set(mmu.banks[0]!, 27 + SPEC_BANK_SIZE * 2);
  // Write PC into the snapshot image at SP (48K map: 5/2/0)
  const poke = (addr: number, v: number) => {
    if (addr >= 0xc000) out[27 + SPEC_BANK_SIZE * 2 + (addr - 0xc000)] = v;
    else if (addr >= 0x8000) out[27 + SPEC_BANK_SIZE + (addr - 0x8000)] = v;
    else if (addr >= 0x4000) out[27 + (addr - 0x4000)] = v;
  };
  poke(sp, pc & 0xff);
  poke((sp + 1) & 0xffff, (pc >> 8) & 0xff);
  return out;
}

/**
 * Save current soft 128 machine as 128K SNA (PC in footer, not on stack).
 */
export function saveSna128(mmu: SpectrumMmu, cpu: SoftZ80State, ula: SpectrumUla): Uint8Array {
  const out = new Uint8Array(SNA_128K_SIZE);
  writeSnaRegs(cpu, ula.border, out, 0);
  const n = mmu.port7ffd & 7;
  out.set(mmu.banks[5]!, 27);
  out.set(mmu.banks[2]!, 27 + SPEC_BANK_SIZE);
  out.set(mmu.banks[n]!, 27 + SPEC_BANK_SIZE * 2);
  const footer = SNA_48K_SIZE;
  out[footer] = cpu.pc & 0xff;
  out[footer + 1] = (cpu.pc >> 8) & 0xff;
  out[footer + 2] = mmu.port7ffd & 0xff;
  out[footer + 3] = mmu.trdosPaged ? 1 : 0;
  let off = footer + 4;
  for (let i = 0; i < 8; i++) {
    if (i === 5 || i === 2 || i === n) continue;
    out.set(mmu.banks[i]!, off);
    off += SPEC_BANK_SIZE;
  }
  return out;
}

export function saveSna(
  mmu: SpectrumMmu,
  cpu: SoftZ80State,
  ula: SpectrumUla,
): Uint8Array {
  return mmu.model === '128' ? saveSna128(mmu, cpu, ula) : saveSna48(mmu, cpu, ula);
}
