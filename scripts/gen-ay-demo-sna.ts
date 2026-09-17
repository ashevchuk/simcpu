/**
 * Build a minimal 128K .SNA that programs the AY chip (tone + border flash).
 * Project-made smoke fixture — not a commercial game.
 *
 * Run: npx vite-node scripts/gen-ay-demo-sna.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSoftZ80 } from '../src/machine/softZ80.js';
import { SpectrumMmu } from '../src/machine/spectrum/mmu.js';
import { SpectrumUla } from '../src/machine/spectrum/ula.js';
import { bootSpectrum } from '../src/machine/spectrum/boot.js';
import { saveSna128, SNA_128K_SIZE } from '../src/machine/spectrum/sna.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(root, 'third_party/spectrum/games/ay-beep128.sna');

/**
 * Machine code @ $8000 (bank 2):
 *   DI
 *   LD A,$07 / OUT (FFFD),A / LD A,$38 / OUT (BFFD),A   ; mixer: tone A only
 *   LD A,$00 / OUT (FFFD),A / LD A,$80 / OUT (BFFD),A   ; fine tune
 *   LD A,$01 / OUT (FFFD),A / LD A,$01 / OUT (BFFD),A   ; coarse
 *   LD A,$08 / OUT (FFFD),A / LD A,$0C / OUT (BFFD),A   ; volume A
 * loop:
 *   LD A,border / OUT (FE),A / INC A / AND 7 / LD (border),A
 *   LD BC,$4000 / DJNZ delay
 *   JR loop
 */
function assembleAyDemo(): Uint8Array {
  const code: number[] = [
    0xf3, // DI
    // mixer reg 7 = $38 (enable tone A)
    0x3e, 0x07, 0xd3, 0xfd, 0x3e, 0x38, 0xd3, 0xfd,
    // Actually AY uses OUT (C),A with BC=FFFD/BFFD — simpler port form:
  ];
  // Rewrite with BC select/data ports (correct for Spectrum 128)
  const prog: number[] = [];
  const emit = (...bs: number[]) => prog.push(...bs);
  emit(0xf3); // DI
  // LD BC,$FFFD
  emit(0x01, 0xfd, 0xff);
  const outReg = (reg: number, val: number) => {
    emit(0x3e, reg, 0xed, 0x79); // LD A,reg / OUT (C),A  select
    emit(0x01, 0xfd, 0xbf); // LD BC,$BFFD
    emit(0x3e, val, 0xed, 0x79); // LD A,val / OUT (C),A
    emit(0x01, 0xfd, 0xff); // LD BC,$FFFD again
  };
  outReg(7, 0x38); // mixer
  outReg(0, 0x60); // fine A
  outReg(1, 0x01); // coarse A
  outReg(8, 0x0c); // vol A
  // border var at $8100
  const borderAddr = 0x8100;
  // LD A,(border)
  emit(0x3a, borderAddr & 0xff, borderAddr >> 8);
  emit(0xd3, 0xfe); // OUT (FE),A
  emit(0x3c); // INC A
  emit(0xe6, 0x07); // AND 7
  emit(0x32, borderAddr & 0xff, borderAddr >> 8); // LD (border),A
  // short delay
  emit(0x01, 0x00, 0x08); // LD BC,$0800
  emit(0x0b); // DEC BC
  emit(0x78, 0xb1, 0x20, 0xfb); // LD A,B / OR C / JR NZ,-5
  emit(0x18, 0xe8); // JR back to LD A,(border) — approximate; fix below

  // Fix loop: rebuild cleanly
  const out: number[] = [];
  const push = (...bs: number[]) => out.push(...bs);
  push(0xf3);
  const ayOut = (reg: number, val: number) => {
    push(0x01, 0xfd, 0xff, 0x3e, reg, 0xed, 0x79);
    push(0x01, 0xfd, 0xbf, 0x3e, val, 0xed, 0x79);
  };
  ayOut(7, 0x38);
  ayOut(0, 0x80);
  ayOut(1, 0x01);
  ayOut(8, 0x0b);
  // init border byte
  push(0x3e, 0x01, 0x32, 0x00, 0x81);
  const loopStart = out.length;
  push(0x3a, 0x00, 0x81); // LD A,(8100)
  push(0xd3, 0xfe);
  push(0x3c, 0xe6, 0x07, 0x32, 0x00, 0x81);
  push(0x01, 0x00, 0x10); // delay
  const delay = out.length;
  push(0x0b, 0x78, 0xb1, 0x20, 0xfb);
  const jrBack = loopStart - (out.length + 2);
  push(0x18, jrBack & 0xff);
  void delay;
  void code;
  return new Uint8Array(out);
}

const mmu = new SpectrumMmu();
const ula = new SpectrumUla();
bootSpectrum(mmu, '128', ula);
const cpu = createSoftZ80(0xffff);
cpu.pc = 0x8000;
cpu.sp = 0xfffd;
cpu.im = 1;
cpu.iff1 = false;
cpu.iff2 = false;
cpu.i = 0x3f;
ula.border = 1;

const code = assembleAyDemo();
mmu.banks[2]!.set(code, 0); // $8000
mmu.banks[2]![0x100] = 1; // $8100 border

const sna = saveSna128(mmu, cpu, ula);
if (sna.length !== SNA_128K_SIZE) throw new Error(`bad size ${sna.length}`);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, sna);
console.log(`Wrote ${outPath} (${sna.length} bytes, code ${code.length}B @8000)`);
