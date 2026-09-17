/**
 * Soft Spectrum register / paging / AY / watch status text for the TTY Spectrum tab.
 */

import type { SoftZ80State } from '../machine/softZ80.js';
import type { Ay8912 } from '../machine/spectrum/ay8912.js';
import type { SpectrumMmu } from '../machine/spectrum/mmu.js';
import type { ContendedStub, ExpansionStub, TrdInfo } from '../machine/spectrum/expansions.js';

function hex2(n: number): string {
  return (n & 0xff).toString(16).padStart(2, '0');
}

function hex4(n: number): string {
  return (n & 0xffff).toString(16).padStart(4, '0');
}

export type SpectrumRegsExtra = {
  watchAddr?: number;
  /** Optional precomputed 64-byte watch dump (worker path). */
  watchBytes?: Uint8Array | null;
  breakpointPc?: number | null;
  breakpointHit?: boolean;
  breakWriteAddr?: number | null;
  breakWriteHit?: boolean;
  contended?: ContendedStub | null;
  expansion?: ExpansionStub | null;
  trd?: TrdInfo | null;
};

export function formatSpectrumRegs(
  cpu: SoftZ80State | null | undefined,
  mmu: SpectrumMmu | null | undefined,
  ay: Ay8912 | null | undefined,
  extra?: SpectrumRegsExtra,
): string {
  if (!cpu) return '— no soft CPU —';
  const iff = `${cpu.iff1 ? 1 : 0}${cpu.iff2 ? 1 : 0}`;
  const lines = [
    `PC=${hex4(cpu.pc)}  SP=${hex4(cpu.sp)}  AF=${hex2(cpu.a)}${hex2(cpu.f)}  BC=${hex2(cpu.b)}${hex2(cpu.c)}`,
    `DE=${hex2(cpu.d)}${hex2(cpu.e)}  HL=${hex2(cpu.h)}${hex2(cpu.l)}  IX=${hex4(cpu.ix)}  IY=${hex4(cpu.iy)}`,
    `I=${hex2(cpu.i)}  R=${hex2(cpu.r)}  IM=${cpu.im}  IFF=${iff}${cpu.halted ? '  HALT' : ''}`,
  ];
  if (mmu) {
    const bank = mmu.pagedBank;
    const rom = mmu.romSelect;
    const scr = mmu.displayBankIndex();
    const trdos = mmu.trdosPaged ? ' TR-DOS' : '';
    lines.push(
      `7FFD=${hex2(mmu.port7ffd)}  bank=${bank}  ROM${rom}  scr=${scr}${mmu.model === '128' ? '  128K' : '  48K'}${trdos}`,
    );
  }
  if (ay) {
    const r = ay.regs;
    const tone = `A=${hex2(r[0]!)}/${hex2(r[1]! & 0x0f)} B=${hex2(r[2]!)}/${hex2(r[3]! & 0x0f)} C=${hex2(r[4]!)}/${hex2(r[5]! & 0x0f)}`;
    lines.push(`AY sel=${hex2(ay.selected)}  ${tone}  mix=${hex2(r[7]!)}  vol=${hex2(r[8]!)}/${hex2(r[9]!)}/${hex2(r[10]!)}`);
  }
  if (extra?.watchAddr != null) {
    const a = extra.watchAddr & 0xffff;
    const dump =
      extra.watchBytes && extra.watchBytes.length >= 64
        ? extra.watchBytes
        : mmu
          ? Uint8Array.from({ length: 64 }, (_, i) => mmu.read((a + i) & 0xffff))
          : null;
    if (dump) {
      for (let row = 0; row < 4; row++) {
        const off = row * 16;
        const bytes = Array.from(dump.subarray(off, off + 16), (b) => hex2(b)).join(' ');
        lines.push(`@${hex4((a + off) & 0xffff)}: ${bytes}`);
      }
    }
  }
  if (extra?.breakpointPc != null) {
    lines.push(`BP=${hex4(extra.breakpointPc)}${extra.breakpointHit ? '  HIT' : ''}`);
  }
  if (extra?.breakWriteAddr != null) {
    lines.push(
      `BW=${hex4(extra.breakWriteAddr)}${extra.breakWriteHit ? '  HIT' : ''}`,
    );
  }
  if (extra?.contended) {
    lines.push(
      `contend≈ hits=${extra.contended.hits} waits=${extra.contended.waitUnits} (soft budget; not T-exact)`,
    );
  }
  if (extra?.expansion) {
    const ex = extra.expansion;
    if (ex.plusModel !== 'none' || ex.port1ffd || ex.divmmcPaged) {
      lines.push(
        `1FFD=${hex2(ex.port1ffd)}  DivMMC=${hex2(ex.divmmcControl)}${ex.divmmcPaged ? ' paged' : ''}  ${ex.plusModel} (latch only)`,
      );
    }
  }
  if (extra?.trd) {
    lines.push(`TRD "${extra.trd.label}" ${extra.trd.sides}side · Beta stub (not full WD1793)`);
  }
  return lines.join('\n');
}
