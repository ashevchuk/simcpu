import { describe, expect, it } from 'vitest';
import { makeZ80Harness } from './z80Harness.js';

/**
 * `IN r,(C)` / `OUT (C),r` — see "x=01, z=0/z=1: IN r,(C) / OUT (C),r" in
 * ARCHITECTURE.md. Port address is `C`; destination/source is `y`. Mid-
 * PHASE4 checkpoints prove `ioRead`/`ioWrite`/`ioPortAddr`/`ioPortDataOut`
 * (the same shape `IN A,(n)` / `OUTI` already use). Device reply `0x99`
 * exercises S/X/P together. Port-byte bit0 is 1 while seeded C is 0, so a
 * wrong "C from data" path would fail the flag check.
 *
 * 0:  0x01,0x42,0x00  LD BC,0x0042   C<-0x42 (port), B<-0
 * 3:  0xED,0x78       IN A,(C)       ioRead/addr=0x42 @ PHASE4; A<-0x99; F from byte, C held
 * 5:  0x06,0xAB       LD B,0xAB
 * 7:  0xED,0x41       OUT (C),B      ioWrite/addr=0x42/data=0xAB @ PHASE4
 * 9:  0xED,0x71       OUT (C),0      ioWrite/data=0 @ PHASE4 (undocumented y=6)
 * 11: 0x3E,0x55       LD A,0x55
 * 13: 0xED,0x70       IN 0,(C)       flags refresh; A stays 0x55 (undocumented y=6)
 * 15: 0xED,0x40       IN B,(C)       B<-0x99
 */
describe('buildZ80Cpu — x=01, z=0/z=1: IN r,(C) / OUT (C),r', () => {
  const PROGRAM = (() => {
    const bytes = new Uint8Array(128);
    bytes.set([0x01, 0x42, 0x00], 0);
    bytes.set([0xed, 0x78], 3);
    bytes.set([0x06, 0xab], 5);
    bytes.set([0xed, 0x41], 7);
    bytes.set([0xed, 0x71], 9);
    bytes.set([0x3e, 0x55], 11);
    bytes.set([0xed, 0x70], 13);
    bytes.set([0xed, 0x40], 15);
    return bytes;
  })();

  // 0x99 = 1001_1001 → S=1,Z=0,Y=0,H=0,X=1,P=1(even),N=0; C left alone (seeded 0).
  // Bit0 of the port byte is 1 — if C were wrongly taken from the data, it
  // would flip; expecting C=0 proves the hold.
  const F_FROM_99 = 0b10001100;

  it('reads/writes the port addressed by C, with y=6 variants and flags', () => {
    const h = makeZ80Harness(PROGRAM, 7, undefined, 0x99);

    // --- LD BC,0x0042 ---
    h.runInstruction();
    expect(h.readReg(h.cpu.rB.q)).toBe(0);
    expect(h.readReg(h.cpu.rC.q)).toBe(0x42);
    expect(h.readReg(h.cpu.pc)).toBe(3);

    // --- IN A,(C) ---
    h.runPhases(4); // INCREMENT..EXEC3 → PHASE4
    expect(h.readPin(h.cpu.ioRead)).toBe(1);
    expect(h.readPin(h.cpu.ioWrite)).toBe(0);
    expect(h.readReg(h.cpu.ioPortAddr)).toBe(0x42);
    h.runPhases(4); // EXEC4..FETCH
    expect(h.readReg(h.cpu.a)).toBe(0x99);
    expect(h.readReg(h.cpu.f)).toBe(F_FROM_99);
    expect(h.readReg(h.cpu.pc)).toBe(5);

    // --- LD B,0xAB ---
    h.runInstruction();
    expect(h.readReg(h.cpu.rB.q)).toBe(0xab);
    expect(h.readReg(h.cpu.pc)).toBe(7);

    // --- OUT (C),B ---
    h.runPhases(4);
    expect(h.readPin(h.cpu.ioWrite)).toBe(1);
    expect(h.readPin(h.cpu.ioRead)).toBe(0);
    expect(h.readReg(h.cpu.ioPortAddr)).toBe(0x42);
    expect(h.readReg(h.cpu.ioPortDataOut)).toBe(0xab);
    h.runPhases(4);
    expect(h.readReg(h.cpu.rB.q)).toBe(0xab);
    expect(h.readReg(h.cpu.pc)).toBe(9);

    // --- OUT (C),0 ---
    h.runPhases(4);
    expect(h.readPin(h.cpu.ioWrite)).toBe(1);
    expect(h.readReg(h.cpu.ioPortAddr)).toBe(0x42);
    expect(h.readReg(h.cpu.ioPortDataOut)).toBe(0);
    h.runPhases(4);
    expect(h.readReg(h.cpu.pc)).toBe(11);

    // --- LD A,0x55 ---
    h.runInstruction();
    expect(h.readReg(h.cpu.a)).toBe(0x55);
    expect(h.readReg(h.cpu.pc)).toBe(13);

    // --- IN 0,(C): flags only ---
    h.runPhases(4);
    expect(h.readPin(h.cpu.ioRead)).toBe(1);
    expect(h.readReg(h.cpu.ioPortAddr)).toBe(0x42);
    h.runPhases(4);
    expect(h.readReg(h.cpu.a)).toBe(0x55); // y=6 never writes a register
    expect(h.readReg(h.cpu.f)).toBe(F_FROM_99);
    expect(h.readReg(h.cpu.pc)).toBe(15);

    // --- IN B,(C) ---
    h.runInstruction();
    expect(h.readReg(h.cpu.rB.q)).toBe(0x99);
    expect(h.readReg(h.cpu.a)).toBe(0x55);
    expect(h.readReg(h.cpu.f)).toBe(F_FROM_99);
    expect(h.readReg(h.cpu.pc)).toBe(17);
  });
});
