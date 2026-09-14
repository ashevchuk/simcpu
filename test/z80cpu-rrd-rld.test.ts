import { describe, expect, it } from 'vitest';
import { makeZ80Harness } from './z80Harness.js';

/**
 * `RRD`/`RLD` — see "x=01, z=7: RRD/RLD" in ARCHITECTURE.md. A 12-bit
 * BCD nibble rotate spanning `A`'s own low nibble and both of `(HL)`'s —
 * `A=0x3A`, `(HL)=0x12` exercises all three nibbles with genuinely
 * distinct values, so a mixed-up rotate direction or a smeared nibble
 * shows up as a wrong digit in a specific place, not a coincidental
 * match. `A`'s own high nibble (`0x3`) must survive both instructions
 * completely untouched — the one thing that turned out to need a real
 * fix (see the doc comment above): `A`'s own `we` commits the whole
 * byte in one edge, so "no layer at all" for the untouched high nibble
 * doesn't hold it, it falls through to the shared ALU's own unrelated,
 * live computation instead. A third case (`A=0`, `(HL)=0`) proves `Z`/
 * `P` land right on the one input where every nibble is already `0`.
 */
describe('buildZ80Cpu — x=01, z=7, y=4/y=5: RRD/RLD', () => {
  interface Snapshot {
    a: number;
    ram10: number;
    f: number;
    pc: number;
  }
  // F bits, LSB first: C,N,P/V,X,H,Y,Z,S. C is deliberately never
  // touched by this pair; H/N are always 0.

  function run(opcode: number, a0: number, hlByte: number, expected: Snapshot[]) {
    const PROGRAM = new Uint8Array(128);
    PROGRAM.set([0x3e, a0, 0x21, 0x10, 0x00, 0xed, opcode], 0); // LD A,a0; LD HL,0x0010; ED,opcode
    PROGRAM[0x10] = hlByte;
    const h = makeZ80Harness(PROGRAM);
    const snapshot = (): Snapshot => ({
      a: h.readReg(h.cpu.a),
      ram10: h.cpu.ram.bytes[0x10]!,
      f: h.readReg(h.cpu.f),
      pc: h.readReg(h.cpu.pc),
    });
    for (const step of expected) {
      h.runInstruction();
      expect(snapshot()).toEqual(step);
    }
  }

  it('RRD rotates (HL) low nibble into A, A low nibble into (HL) high, (HL) high into (HL) low', () => {
    run(0x67, 0x3a, 0x12, [
      { a: 0x3a, ram10: 0x12, f: 0, pc: 2 }, // LD A,0x3A — RAM[0x10] still the seeded (HL) byte
      { a: 0x3a, ram10: 0x12, f: 0, pc: 5 }, // LD HL,0x0010
      { a: 0x32, ram10: 0xa1, f: 0b00100000, pc: 7 }, // RRD: S=0,Z=0,Y=1,H=0,X=0,P/V=0(odd),N=0,C=0
    ]);
  });

  it('RLD rotates (HL) low nibble into (HL) high, (HL) high into A, A low nibble into (HL) low', () => {
    run(0x6f, 0x3a, 0x12, [
      { a: 0x3a, ram10: 0x12, f: 0, pc: 2 }, // LD A,0x3A — RAM[0x10] still the seeded (HL) byte
      { a: 0x3a, ram10: 0x12, f: 0, pc: 5 }, // LD HL,0x0010
      { a: 0x31, ram10: 0x2a, f: 0b00100000, pc: 7 }, // RLD: S=0,Z=0,Y=1,H=0,X=0,P/V=0(odd),N=0,C=0
    ]);
  });

  it('RRD on an all-zero A and (HL) sets Z and even parity', () => {
    run(0x67, 0x00, 0x00, [
      { a: 0x00, ram10: 0x00, f: 0, pc: 2 }, // LD A,0x00
      { a: 0x00, ram10: 0x00, f: 0, pc: 5 }, // LD HL,0x0010
      { a: 0x00, ram10: 0x00, f: 0b01000100, pc: 7 }, // RRD: S=0,Z=1,H=0,P/V=1(even),N=0,C=0
    ]);
  });
});
