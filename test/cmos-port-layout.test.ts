/**
 * CMOS port layout: IN a / IN b must not share a Y (NAND glued-port bug).
 */
import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { seedStandardCells } from '../src/sim/stdcells.js';

describe('CMOS primitive port layout', () => {
  function portsOf(name: string) {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const def = library.findByName(name);
    expect(def).toBeTruthy();
    const ports = [...def!.circuit.components.values()].filter((c) => c.kind === 'port');
    return Object.fromEntries(ports.map((p) => [p.name, { x: p.pos.x, y: p.pos.y, dir: p.dir }]));
  }

  it('NAND separates IN a and IN b vertically', () => {
    const p = portsOf('NAND');
    expect(p.a?.dir).toBe('in');
    expect(p.b?.dir).toBe('in');
    expect(p.out?.dir).toBe('out');
    expect(Math.abs(p.a!.y - p.b!.y)).toBeGreaterThanOrEqual(64);
    expect(p.a!.x).toBeLessThan(p.out!.x);
    expect(p.b!.x).toBeLessThan(p.out!.x);
  });

  it('NOR separates IN a and IN b vertically', () => {
    const p = portsOf('NOR');
    expect(Math.abs(p.a!.y - p.b!.y)).toBeGreaterThanOrEqual(64);
  });

  it('AND / OR keep distinct inputs after NAND/NOR + inv', () => {
    for (const name of ['AND', 'OR'] as const) {
      const p = portsOf(name);
      expect(Math.abs(p.a!.y - p.b!.y)).toBeGreaterThanOrEqual(64);
    }
  });

  it('NOT keeps single in left of out', () => {
    const p = portsOf('NOT');
    expect(p.in?.dir).toBe('in');
    expect(p.out?.dir).toBe('out');
    expect(p.in!.x).toBeLessThan(p.out!.x);
  });

  it('relayout fixes glued ports on an already-seeded NAND (autosave case)', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const def = library.findByName('NAND')!;
    for (const c of def.circuit.components.values()) {
      if (c.kind === 'port' && c.name !== 'out') {
        c.pos = { x: -72, y: 0 };
        c.pins.io.pos = { ...c.pos };
      }
    }
    expect(Math.abs(
      [...def.circuit.components.values()].find((c) => c.kind === 'port' && c.name === 'a')!.pos.y -
        [...def.circuit.components.values()].find((c) => c.kind === 'port' && c.name === 'b')!.pos.y,
    )).toBeLessThan(8);
    // Second seed must unglue even though transistor span is already modern.
    seedStandardCells(library);
    const a = [...def.circuit.components.values()].find((c) => c.kind === 'port' && c.name === 'a')!;
    const b = [...def.circuit.components.values()].find((c) => c.kind === 'port' && c.name === 'b')!;
    expect(Math.abs(a.pos.y - b.pos.y)).toBeGreaterThanOrEqual(64);
  });
});
