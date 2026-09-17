/**
 * Build a minimal 48K .SNA that paints a bright paper-colour rainbow on the attrs.
 * Project smoke fixture — was previously broken (EI + bad JR → white screen / ROM IRQ).
 *
 * Run: npx vite-node scripts/gen-rainbow-demo-sna.ts
 * Then: npx vite-node scripts/gen-spectrum-games.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSoftZ80 } from '../src/machine/softZ80.js';
import { SpectrumMmu } from '../src/machine/spectrum/mmu.js';
import { SpectrumUla } from '../src/machine/spectrum/ula.js';
import { bootSpectrum } from '../src/machine/spectrum/boot.js';
import { saveSna48 } from '../src/machine/spectrum/sna.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(root, 'third_party/spectrum/games/rainbow-demo.sna');

/**
 *   DI
 *   LD HL,$5800
 *   LD BC,768
 *   LD D,0
 * loop:
 *   LD A,D / AND 7 / ADD A,A×3 / OR $40 / LD (HL),A
 *   INC HL / INC D / DEC BC / LD A,B / OR C / JR NZ,loop
 *   JR $
 */
function assembleRainbow(): Uint8Array {
  const out: number[] = [];
  const push = (...bs: number[]) => out.push(...bs);
  push(0xf3); // DI
  push(0x21, 0x00, 0x58); // LD HL,$5800
  push(0x01, 0x00, 0x03); // LD BC,768
  push(0x16, 0x00); // LD D,0
  const loop = out.length;
  push(0x7a); // LD A,D
  push(0xe6, 0x07); // AND 7
  push(0x87, 0x87, 0x87); // ADD A,A ×3 → paper bits
  push(0xf6, 0x40); // OR $40 bright
  push(0x77); // LD (HL),A
  push(0x23); // INC HL
  push(0x14); // INC D
  push(0x0b); // DEC BC
  push(0x78, 0xb1); // LD A,B / OR C
  const jrAt = out.length;
  push(0x20, 0x00); // JR NZ,loop (patch)
  const afterJr = out.length;
  out[jrAt + 1] = (loop - afterJr) & 0xff;
  push(0x18, 0xfe); // JR $
  return new Uint8Array(out);
}

const mmu = new SpectrumMmu();
const ula = new SpectrumUla();
const cpu = createSoftZ80();
bootSpectrum(mmu, '48', ula);

const code = assembleRainbow();
mmu.banks[2]!.set(code, 0); // $8000

// Pre-bake attrs so the first frame already shows colour (blank pixels → paper).
const attrs = mmu.banks[5]!.subarray(0x1800, 0x1b00);
for (let i = 0; i < 768; i++) {
  const paper = i & 7;
  attrs[i] = ((paper << 3) | 0x40) & 0xff;
}

cpu.pc = 0x8000;
cpu.sp = 0xff4a;
cpu.iff1 = false;
cpu.iff2 = false;
cpu.im = 1;
cpu.i = 0x3f;
ula.border = 1; // blue

const sna = saveSna48(mmu, cpu, ula);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, sna);
console.log(`Wrote ${outPath} (${sna.length} bytes, code ${code.length}B @8000, attrs pre-painted)`);
