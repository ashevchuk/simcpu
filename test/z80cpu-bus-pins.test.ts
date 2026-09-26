import { describe, expect, it } from 'vitest';
import { makeZ80Harness } from './z80Harness.js';

describe('Z80CPU bus pins', () => {
  it('exposes IORQ/M1/RD/WR/MREQ and asserts IORQ∧WR on OUT', () => {
    // LD A,1 ; OUT (40h),A ; HALT
    const prog = Uint8Array.of(0x3e, 0x01, 0xd3, 0x40, 0x76);
    const h = makeZ80Harness(prog);
    expect(h.cpu.iorq).toBeTruthy();
    expect(h.cpu.m1).toBeTruthy();
    expect(h.cpu.rd).toBeTruthy();
    expect(h.cpu.wr).toBeTruthy();
    expect(h.cpu.mreq).toBeTruthy();

    h.runInstruction(); // LD A,1
    let sawIorqWr = false;
    for (let i = 0; i < 10; i++) {
      h.runPhases(1);
      const iorq = h.readPin(h.cpu.iorq) === 1;
      const wr = h.readPin(h.cpu.wr) === 1;
      const m1 = h.readPin(h.cpu.m1) === 1;
      if (iorq && wr) {
        sawIorqWr = true;
        expect(m1).toBe(false); // I/O cycle is not M1
        break;
      }
    }
    expect(sawIorqWr).toBe(true);
  });

  it('asserts IORQ∧M1 during INTACK', () => {
    const ADDR_BITS = 7;
    const prog = new Uint8Array(1 << ADDR_BITS);
    prog.set([0xed, 0x56], 0); // IM 1
    prog.set([0xfb], 2); // EI
    prog.set([0x00], 3); // NOP — IFF commits; wrap PHASE0 accepts INT
    prog.set([0x76], 4); // HALT
    prog.set([0x76], 0x38); // ISR stub

    const h = makeZ80Harness(prog, ADDR_BITS, (cpu, seedReg) => {
      seedReg(cpu.rB, 0);
      seedReg(cpu.rC, 0);
      seedReg(cpu.rD, 0);
      seedReg(cpu.rE, 0);
      seedReg(cpu.rH, 0);
      seedReg(cpu.rL, 0);
      seedReg(cpu.rIXH, 0);
      seedReg(cpu.rIXL, 0);
      seedReg(cpu.rIYH, 0);
      seedReg(cpu.rIYL, 0);
      seedReg(cpu.sp, 0x60, ADDR_BITS);
      seedReg(cpu.aP, 0);
      seedReg(cpu.fP, 0);
      seedReg(cpu.bP, 0);
      seedReg(cpu.cP, 0);
      seedReg(cpu.dP, 0);
      seedReg(cpu.eP, 0);
      seedReg(cpu.hP, 0);
      seedReg(cpu.lP, 0);
    });

    h.runInstruction(); // IM 1
    h.intInput.value = 1;
    h.runInstruction(); // EI (IFF still off at FETCH)
    // NOP: IFF commits mid-instr; wrap PHASE0 accepts INT — sample each phase
    let sawIorqM1 = false;
    for (let i = 0; i < 10; i++) {
      h.runPhases(1);
      if (h.readPin(h.cpu.iorq) === 1 && h.readPin(h.cpu.m1) === 1) {
        sawIorqM1 = true;
        break;
      }
    }
    expect(sawIorqM1).toBe(true);
    expect(h.readReg(h.cpu.ir)).toBe(0xff);
  });
});
