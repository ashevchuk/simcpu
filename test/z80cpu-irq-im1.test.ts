import { describe, expect, it } from 'vitest';
import { makeZ80Harness } from './z80Harness.js';

/**
 * Thin IM1 IRQ — EI/DI, IM 1, INT→RST 38h, RETI.
 * See "Thin IM1 IRQ" in ARCHITECTURE.md / Known Simplifications.
 */
describe('buildZ80Cpu — thin IM1 IRQ', () => {
  it('EI/DI and IM 1 toggle IFF/IM1; INT forces RST 38h; RETI restores IFF1 from IFF2', () => {
    const ADDR_BITS = 7;
    const SP0 = 0x60;
    const PROGRAM = (() => {
      const bytes = new Uint8Array(1 << ADDR_BITS);
      // 0: IM 1 (ED 56)
      bytes.set([0xed, 0x56], 0);
      // 2: EI
      bytes.set([0xfb], 2);
      // 3: NOP — INT accepted here instead → RST 38h
      bytes.set([0x00], 3);
      // 4: would be next if no INT — return target after RETI
      bytes.set([0x3e, 0x99], 4); // LD A,0x99 — proves RETI resumed here
      // 0x38: ISR — LD B,0x42 ; RETI
      bytes.set([0x06, 0x42], 0x38);
      bytes.set([0xed, 0x4d], 0x3a); // RETI
      return bytes;
    })();

    const h = makeZ80Harness(PROGRAM, ADDR_BITS, (cpu, seedReg) => {
      seedReg(cpu.rB, 0);
      seedReg(cpu.rC, 0);
      seedReg(cpu.rD, 0);
      seedReg(cpu.rE, 0);
      seedReg(cpu.rH, 0);
      seedReg(cpu.rL, 0);
      seedReg(cpu.sp, SP0, ADDR_BITS);
      seedReg(cpu.aP, 0);
      seedReg(cpu.fP, 0);
      seedReg(cpu.bP, 0);
      seedReg(cpu.cP, 0);
      seedReg(cpu.dP, 0);
      seedReg(cpu.eP, 0);
      seedReg(cpu.hP, 0);
      seedReg(cpu.lP, 0);
    });

    expect(h.readReg(h.cpu.iff1)).toBe(0);
    expect(h.readReg(h.cpu.iff2)).toBe(0);
    expect(h.readReg(h.cpu.im1)).toBe(0);

    h.runInstruction(); // IM 1
    expect(h.readReg(h.cpu.im1)).toBe(1);
    expect(h.readReg(h.cpu.pc)).toBe(2);

    // Arm INT before EI finishes: EI's final wrap-to-PHASE0 is the FETCH
    // that would have loaded NOP at 3 — accept forces IR=0xFF (RST 38h) instead.
    h.intInput.value = 1;
    h.runInstruction(); // EI (IFF set on PHASE2), then INT-accept FETCH
    expect(h.readReg(h.cpu.iff1)).toBe(0); // cleared on accept
    expect(h.readReg(h.cpu.ir)).toBe(0xff);
    expect(h.readReg(h.cpu.pc)).toBe(3); // not yet advanced — intServing holds PHASE1

    h.intInput.value = 0;
    h.runInstruction(); // finish RST 38h: push PC=3, jump to 0x38, fetch ISR

    expect(h.readReg(h.cpu.pc)).toBe(0x38);
    expect(h.readReg(h.cpu.iff2)).toBe(0);
    expect(h.readReg(h.cpu.sp.q)).toBe(SP0 - 1);
    expect(h.cpu.ram.bytes[SP0 - 1]).toBe(3);

    h.runInstruction(); // LD B,0x42
    expect(h.readReg(h.cpu.rB.q)).toBe(0x42);

    h.runInstruction(); // RETI — pop PC=3, IFF1←IFF2(=0)
    expect(h.readReg(h.cpu.pc)).toBe(3);
    expect(h.readReg(h.cpu.sp.q)).toBe(SP0);
    expect(h.readReg(h.cpu.iff1)).toBe(0);

    // Re-enable and continue past the interrupted NOP
    h.runInstruction(); // NOP at 3
    expect(h.readReg(h.cpu.pc)).toBe(4);

    h.runInstruction(); // LD A,0x99
    expect(h.readReg(h.cpu.a)).toBe(0x99);
    expect(h.readReg(h.cpu.pc)).toBe(6);
  });

  it('DI clears IFF; INT is ignored while disabled', () => {
    const PROGRAM = (() => {
      const bytes = new Uint8Array(128);
      bytes.set([0xed, 0x56], 0); // IM 1
      bytes.set([0xfb], 2); // EI
      bytes.set([0xf3], 3); // DI
      bytes.set([0x3e, 0x11], 4); // LD A,0x11 — must run, not RST
      return bytes;
    })();
    const h = makeZ80Harness(PROGRAM);

    h.runInstruction(); // IM 1
    h.runInstruction(); // EI
    expect(h.readReg(h.cpu.iff1)).toBe(1);

    h.runInstruction(); // DI
    expect(h.readReg(h.cpu.iff1)).toBe(0);
    expect(h.readReg(h.cpu.iff2)).toBe(0);

    h.intInput.value = 1;
    h.runInstruction(); // LD A,0x11 — INT ignored
    h.intInput.value = 0;
    expect(h.readReg(h.cpu.a)).toBe(0x11);
    expect(h.readReg(h.cpu.pc)).toBe(6);
  });
});
