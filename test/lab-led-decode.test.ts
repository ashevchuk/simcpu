import { describe, expect, it } from 'vitest';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { seedStandardCells } from '../src/sim/stdcells.js';
import { placeLabLedGateDecode } from '../src/machine/labLedGateDecode.js';
import { PORT_LAB_LED } from '../src/machine/memoryMap.js';

describe('LAB_LED_DECODE', () => {
  it('registers ChipDef and wires CPU I/O taps', () => {
    const library = new ChipLibrary();
    seedStandardCells(library);
    const circuit = new Circuit();
    const cpu = buildZ80Cpu(circuit, library, 16, new Uint8Array([0xc3, 0, 0]), { x: 0, y: 0 });
    const out = placeLabLedGateDecode(circuit, library, cpu, { x: 800, y: 0 });
    const def = library.findByName('LAB_LED_DECODE');
    expect(def).toBeTruthy();
    expect(def!.ports).toEqual([
      'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'iorq', 'wr', 'd0', 'out',
    ]);
    expect(out.id).toBeTruthy();
    expect(PORT_LAB_LED).toBe(0x40);
    const chips = [...circuit.components.values()].filter(
      (c) => c.kind === 'chip' && (c as { defName?: string }).defName === 'LAB_LED_DECODE'
        || (c.kind === 'chip' && library.get((c as { defId: string }).defId)?.name === 'LAB_LED_DECODE'),
    );
    expect(chips.length).toBeGreaterThanOrEqual(1);
  });
});
