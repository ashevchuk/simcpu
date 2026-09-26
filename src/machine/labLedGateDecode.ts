/**
 * Gates-path lab LED: decode OUT (PORT_LAB_LED) bit0 from the Z80CPU I/O
 * taps onto a pin that can drive the canvas LED. Must be placed *outside*
 * the fold selection so crossing wires become chip ports (not a FET IORQ+M1
 * cycle — reuses existing ioWrite + 8-bit port address).
 */

import type { ChipLibrary } from '../sim/ChipLibrary.js';
import type { Circuit } from '../sim/Circuit.js';
import type { Z80Cpu } from '../sim/blocks.js';
import {
  buildAnd,
  buildNot,
  makeChipGatePlacer,
  makeLabel,
  makeProbe,
  setCircuitGatePlacer,
  wire,
} from '../sim/library.js';
import type { Pin, Point } from '../sim/types.js';
import { PORT_LAB_LED } from './memoryMap.js';

/**
 * Combinational: `ioWrite ∧ (ioPortAddr == PORT_LAB_LED) ∧ ioPortDataOut[0]`.
 * Returns the decode output pin (also labeled `LAB_LED_GATE`).
 */
export function placeLabLedGateDecode(
  circuit: Circuit,
  library: ChipLibrary,
  cpu: Z80Cpu,
  pos: Point,
): Pin {
  const not = library.findByName('NOT');
  const nand = library.findByName('NAND');
  const and = library.findByName('AND');
  const nor = library.findByName('NOR');
  const or = library.findByName('OR');
  if (!not || !nand || !and || !nor || !or) {
    throw new Error('placeLabLedGateDecode: seedStandardCells first');
  }
  setCircuitGatePlacer(circuit, makeChipGatePlacer({ not, nand, and, nor, or }));
  try {
    const matchBits: Pin[] = [];
    for (let i = 0; i < 8; i++) {
      const addr = cpu.ioPortAddr[i]!;
      const want = ((PORT_LAB_LED >> i) & 1) === 1;
      if (want) {
        matchBits.push(addr);
      } else {
        const inv = buildNot(circuit, { x: pos.x, y: pos.y + i * 50 });
        wire(circuit, addr, inv.in);
        matchBits.push(inv.out);
      }
    }
    let acc = matchBits[0]!;
    for (let i = 1; i < matchBits.length; i++) {
      const g = buildAnd(circuit, { x: pos.x + 180 + i * 50, y: pos.y });
      wire(circuit, acc, g.a);
      wire(circuit, matchBits[i]!, g.b);
      acc = g.out;
    }
    const withWr = buildAnd(circuit, { x: pos.x + 620, y: pos.y + 100 });
    wire(circuit, acc, withWr.a);
    wire(circuit, cpu.ioWrite, withWr.b);
    const withD0 = buildAnd(circuit, { x: pos.x + 760, y: pos.y + 100 });
    wire(circuit, withWr.out, withD0.a);
    wire(circuit, cpu.ioPortDataOut[0]!, withD0.b);
    const probe = makeProbe(circuit, { x: pos.x + 900, y: pos.y + 100 }, 'LAB_LED_GATE');
    wire(circuit, withD0.out, probe.pins.in);
    const lbl = makeLabel(circuit, 'LAB_LED_GATE', {
      x: pos.x + 920,
      y: pos.y + 80,
    });
    wire(circuit, withD0.out, lbl.pins.net);
    return withD0.out;
  } finally {
    setCircuitGatePlacer(circuit, null);
  }
}
