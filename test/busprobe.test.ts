import { describe, expect, it } from 'vitest';
import { decodeBusProbe } from '../src/sim/busProbe.js';
import { Circuit } from '../src/sim/Circuit.js';
import { makeBusProbe, makeInput, makeSource, wire } from '../src/sim/library.js';
import { serializeProject, deserializeProject } from '../src/sim/serialize.js';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';

describe('bus probe decode', () => {
  it('decodes driven bits to hex/dec/bin', () => {
    const levels = [
      { level: 1 as const, contended: false },
      { level: 0 as const, contended: false },
      { level: 1 as const, contended: false },
      { level: 0 as const, contended: false },
    ];
    expect(decodeBusProbe(levels, 'hex')).toEqual({
      value: 0b0101,
      bitsMsbFirst: '0101',
      text: '5',
    });
    expect(decodeBusProbe(levels, 'dec').text).toBe('5');
    expect(decodeBusProbe(levels, 'bin').text).toBe('0101');
  });

  it('marks floating / contended as incomplete', () => {
    const z = decodeBusProbe(
      [
        { level: 1, contended: false },
        { level: 'Z', contended: false },
      ],
      'hex',
    );
    expect(z.value).toBeNull();
    expect(z.bitsMsbFirst).toBe('Z1');
    expect(z.text).toBe('?');

    const x = decodeBusProbe([{ level: 1, contended: true }], 'bin');
    expect(x.value).toBeNull();
    expect(x.bitsMsbFirst).toBe('X');
  });

  it('round-trips through project serialize', () => {
    const circuit = new Circuit();
    makeSource(circuit, 1, { x: 0, y: 0 });
    makeSource(circuit, 0, { x: 0, y: 40 });
    const bus = makeBusProbe(circuit, 4, { x: 100, y: 0 }, 'dec');
    const a = makeInput(circuit, 1, { x: 40, y: -20 });
    wire(circuit, a.pins.out, bus.pins.b0!);
    const lib = new ChipLibrary();
    const json = serializeProject(circuit, lib);
    const { topCircuit } = deserializeProject(json);
    const loaded = [...topCircuit.components.values()].find((c) => c.kind === 'busprobe');
    expect(loaded?.kind).toBe('busprobe');
    if (loaded?.kind === 'busprobe') {
      expect(loaded.bitWidth).toBe(4);
      expect(loaded.radix).toBe('dec');
      expect(loaded.pins.b0).toBeTruthy();
      expect(loaded.pins.b3).toBeTruthy();
    }
  });
});
