import { describe, expect, it } from 'vitest';
import { createSoftZ80, softRun, type SoftMemHooks } from '../src/machine/softZ80.js';
import { bootSpectrum, bootSpectrum48, loadSpectrumRom } from '../src/machine/spectrum/boot.js';
import { SpectrumMmu } from '../src/machine/spectrum/mmu.js';
import {
  applySna,
  applySna48,
  isSna48,
  isSna128,
  SNA_48K_SIZE,
  SNA_128K_SIZE,
} from '../src/machine/spectrum/sna.js';
import {
  buildCodeTap,
  parseTap,
  SpectrumTape,
  trapLdBytes,
} from '../src/machine/spectrum/tap.js';
import { SpectrumUla } from '../src/machine/spectrum/ula.js';

function spectrumHooks(mmu: SpectrumMmu, ula: SpectrumUla, tape?: SpectrumTape): SoftMemHooks {
  return {
    addrBits: 16,
    memRead: (a) => mmu.read(a),
    memWrite: (a, v) => mmu.write(a, v),
    portIn: (p) => ula.portIn(p),
    portOut: (p, v) => {
      if (SpectrumMmu.isPort7ffd(p) && mmu.model === '128') mmu.out7ffd(v);
      else ula.portOut(p, v);
    },
    irqPending: () => ula.irqPending,
    clearIrq: () => ula.clearIrq(),
    hostTrap: tape
      ? (cpu, ram) =>
          trapLdBytes(cpu, ram, tape, {
            read: (a) => mmu.read(a),
            write: (a, v) => mmu.write(a, v),
          })
      : undefined,
  };
}

/** Build a minimal valid 48K SNA that RETs to a tiny RAM program. */
function buildToySna(): Uint8Array {
  const sna = new Uint8Array(SNA_48K_SIZE);
  sna[19] = 0x04;
  sna[23] = 0xfc;
  sna[24] = 0xff;
  sna[25] = 1;
  sna[26] = 2;
  const ramOff = (addr: number) => 27 + (addr - 0x4000);
  sna[ramOff(0x8000)] = 0x3e;
  sna[ramOff(0x8001)] = 0x04;
  sna[ramOff(0x8002)] = 0x32;
  sna[ramOff(0x8003)] = 0x00;
  sna[ramOff(0x8004)] = 0x58;
  sna[ramOff(0x8005)] = 0x76;
  sna[ramOff(0xfffc)] = 0x00;
  sna[ramOff(0xfffd)] = 0x80;
  for (let a = 0x5800; a < 0x5b00; a++) sna[ramOff(a)] = 0x38;
  return sna;
}

/** Minimal 128K SNA: PC=0x8000, 7FFD=bank1, marker in bank 1. */
function buildToySna128(): Uint8Array {
  const sna = new Uint8Array(SNA_128K_SIZE);
  sna[19] = 0x04;
  sna[23] = 0x00;
  sna[24] = 0xc0; // SP unused for PC
  sna[25] = 1;
  sna[26] = 3; // border
  const ramOff = (addr: number) => 27 + (addr - 0x4000);
  // Visible bank at C000 is bank 1 — put a HALT program there mirrored in image
  // Image layout: bank5, bank2, bank n(=1)
  sna[ramOff(0xc000)] = 0x76; // HALT at start of paged bank image
  // Footer
  const footer = SNA_48K_SIZE;
  sna[footer] = 0x00;
  sna[footer + 1] = 0xc0; // PC = C000
  sna[footer + 2] = 0x01; // 7FFD = bank 1
  sna[footer + 3] = 0; // TR-DOS off
  // Remaining banks ascending skip 5,2,1 → 0,3,4,6,7
  // Put marker 0xA5 at start of bank 0 in remaining section
  const rem0 = footer + 4;
  sna[rem0] = 0xa5;
  return sna;
}

describe('Spectrum SNA', () => {
  it('rejects wrong size', () => {
    expect(isSna48(new Uint8Array(100))).toBe(false);
    expect(isSna48(new Uint8Array(SNA_48K_SIZE))).toBe(true);
    expect(isSna128(new Uint8Array(131103))).toBe(true);
    expect(isSna128(new Uint8Array(100))).toBe(false);
  });

  it('applies regs, RAM, border, and pops PC (48K)', () => {
    const mmu = new SpectrumMmu();
    const ula = new SpectrumUla();
    bootSpectrum(mmu, '48', ula);
    const cpu = createSoftZ80(0xffff);
    const sna = buildToySna();
    const { pc, border } = applySna48(mmu, cpu, ula, sna);
    expect(pc).toBe(0x8000);
    expect(border).toBe(2);
    expect(cpu.sp).toBe(0xfffe);
    expect(cpu.im).toBe(1);
    expect(cpu.iff1).toBe(true);
    expect(mmu.read(0x8000)).toBe(0x3e);

    softRun(cpu, new Uint8Array(0x10000), 20, spectrumHooks(mmu, ula));
    expect(mmu.read(0x5800)).toBe(0x04);
    expect(cpu.halted).toBe(true);
  });

  it('loads 48K SNA with stack-popped PC (toy)', () => {
    const mmu = new SpectrumMmu();
    const ula = new SpectrumUla();
    bootSpectrum(mmu, '48', ula);
    const cpu = createSoftZ80(0xffff);
    const sna = buildToySna();
    expect(isSna48(sna)).toBe(true);
    const { pc, border, model } = applySna(mmu, cpu, ula, sna);
    expect(model).toBe('48');
    expect(pc).toBe(0x8000);
    expect(border).toBe(2);
  });

  it('loads 128K SNA with PC footer and 7FFD banking', () => {
    const mmu = new SpectrumMmu();
    const ula = new SpectrumUla();
    bootSpectrum(mmu, '128', ula);
    const cpu = createSoftZ80(0xffff);
    const sna = buildToySna128();
    const { pc, border, model, port7ffd } = applySna(mmu, cpu, ula, sna);
    expect(model).toBe('128');
    expect(pc).toBe(0xc000);
    expect(border).toBe(3);
    expect(port7ffd & 7).toBe(1);
    expect(mmu.pagedBank).toBe(1);
    expect(mmu.read(0xc000)).toBe(0x76);
    expect(mmu.banks[0]![0]).toBe(0xa5);

    softRun(cpu, new Uint8Array(0x10000), 5, spectrumHooks(mmu, ula));
    expect(cpu.halted).toBe(true);

    // Page bank 0 into C000 via OUT 7FFD
    cpu.halted = false;
    // LD A,0 / OUT (0xFD),A with BC=7FFD — simpler: call mmu.out7ffd
    mmu.out7ffd(0x00);
    expect(mmu.read(0xc000)).toBe(0xa5);
  });

  it('pages RAM via soft OUT to 7FFD', () => {
    const mmu = new SpectrumMmu();
    const ula = new SpectrumUla();
    bootSpectrum(mmu, '128', ula);
    mmu.banks[3]![0] = 0x3c;
    const cpu = createSoftZ80(0xffff);
    // Program at 8000: LD A,3 / LD BC,7FFD / OUT (C),A / LD A,(C000) / HALT
    const ram = new Uint8Array(0x10000);
    const prog = [0x3e, 0x03, 0x01, 0xfd, 0x7f, 0xed, 0x79, 0x3a, 0x00, 0xc0, 0x76];
    for (let i = 0; i < prog.length; i++) mmu.write(0x8000 + i, prog[i]!);
    cpu.pc = 0x8000;
    softRun(cpu, ram, 40, spectrumHooks(mmu, ula));
    expect(mmu.pagedBank).toBe(3);
    expect(cpu.a).toBe(0x3c);
    expect(cpu.halted).toBe(true);
  });
});

describe('Spectrum TAP', () => {
  it('parses header+data CODE tap', () => {
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const tap = buildCodeTap('TEST', 0x8000, payload);
    const blocks = parseTap(tap);
    expect(blocks.length).toBe(2);
    expect(blocks[0]!.flag).toBe(0x00);
    expect(blocks[0]!.data.length).toBe(17);
    expect(blocks[0]!.data[0]).toBe(3);
    expect(blocks[1]!.flag).toBe(0xff);
    expect([...blocks[1]!.data]).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
  });

  it('flash-loads via LD-BYTES trap', () => {
    const payload = new Uint8Array(16).map((_, i) => i + 1);
    const tape = SpectrumTape.fromBytes(buildCodeTap('BLOB', 0x9000, payload));
    const mmu = new SpectrumMmu();
    const ula = new SpectrumUla();
    bootSpectrum(mmu, '48', ula);
    const cpu = createSoftZ80(0xffff);

    // Return into RAM (ROM @1234 would execute firmware)
    const ret = 0x8000;
    cpu.sp = 0xfffc;
    mmu.write(0xfffc, ret & 0xff);
    mmu.write(0xfffd, (ret >> 8) & 0xff);
    mmu.write(ret, 0x76); // HALT
    cpu.a = 0xff;
    cpu.f = 0x01; // carry = load
    cpu.d = 0;
    cpu.e = 16;
    cpu.ix = 0x9000;
    cpu.pc = 0x0556;
    cpu.iff1 = false;
    cpu.iff2 = false;

    const hooks = spectrumHooks(mmu, ula, tape);
    expect(hooks.hostTrap!(cpu, new Uint8Array(0x10000))).toBe(true);
    // Trap EI's (SA_LD_RET semantics) then RETs to caller
    expect(cpu.pc).toBe(ret);
    expect(cpu.iff1).toBe(true);
    softRun(cpu, new Uint8Array(0x10000), 5, hooks);
    expect(cpu.halted).toBe(true);
    for (let i = 0; i < 16; i++) expect(mmu.read(0x9000 + i)).toBe(i + 1);
  });

  it('legacy flat bootSpectrum48 still clears RAM', () => {
    const ram = new Uint8Array(0x10000);
    ram[0x5000] = 0x99;
    const ula = new SpectrumUla();
    bootSpectrum48(ram, ula);
    loadSpectrumRom(ram); // already done by boot — ensure ROM byte
    expect(ram[0]).toBe(0xf3);
    expect(ram[0x5000]).toBe(0);
  });
});
