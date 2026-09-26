/**
 * Gates-path lab LED: decode OUT (PORT_LAB_LED) bit0 from the Z80CPU I/O
 * taps onto a pin that can drive the canvas LED. Must be placed *outside*
 * the fold selection so crossing wires become chip ports.
 *
 * Logic lives in ChipDef `LAB_LED_DECODE` (combinational fold); placement
 * only wires CPU taps into an instance.
 *
 * Formula: `iorq ∧ wr ∧ (a[7:0] == PORT_LAB_LED) ∧ d0`
 * (equivalent to ioWrite∧addr∧d0 once wr includes ioWrite and iorq includes it).
 */

import type { ChipDef, ChipLibrary } from '../sim/ChipLibrary.js';
import type { Circuit } from '../sim/Circuit.js';
import { Circuit as CircuitCtor } from '../sim/Circuit.js';
import type { Z80Cpu } from '../sim/blocks.js';
import { foldExposing } from '../sim/hierarchy.js';
import {
  makeChipInstance,
  makeLabel,
  makeProbe,
  makeSource,
  wire,
} from '../sim/library.js';
import type { Pin, Point } from '../sim/types.js';
import { PORT_LAB_LED } from './memoryMap.js';

const labLedDecodeDefs = new WeakMap<ChipLibrary, ChipDef>();

type TwoPin = { a: Pin; b: Pin; out: Pin };
type OnePin = { in: Pin; out: Pin };

function placeAnd(circuit: Circuit, def: ChipDef, pos: Point): TwoPin {
  const inst = makeChipInstance(circuit, def, pos);
  return {
    a: inst.pins[def.ports[0]!]!,
    b: inst.pins[def.ports[1]!]!,
    out: inst.pins[def.ports[2]!]!,
  };
}

function placeNot(circuit: Circuit, def: ChipDef, pos: Point): OnePin {
  const inst = makeChipInstance(circuit, def, pos);
  return {
    in: inst.pins[def.ports[0]!]!,
    out: inst.pins[def.ports[1]!]!,
  };
}

/**
 * Combinational: `iorq ∧ wr ∧ (a[7:0] == PORT_LAB_LED) ∧ d0`.
 * Ports: a0..a7, iorq, wr, d0, out.
 */
function makeLabLedDecodeChip(library: ChipLibrary): ChipDef {
  const notDef = library.findByName('NOT');
  const andDef = library.findByName('AND');
  if (!notDef || !andDef) {
    throw new Error('makeLabLedDecodeChip: seedStandardCells first');
  }

  const scratch = new CircuitCtor();
  const vcc = makeSource(scratch, 1);
  makeSource(scratch, 0);

  const addrPorts: Pin[] = [];
  const matchBits: Pin[] = [];
  for (let i = 0; i < 8; i++) {
    const want = ((PORT_LAB_LED >> i) & 1) === 1;
    if (want) {
      const g = placeAnd(scratch, andDef, { x: 0, y: i * 60 });
      wire(scratch, vcc.pins.out, g.b);
      addrPorts.push(g.a);
      matchBits.push(g.out);
    } else {
      const inv = placeNot(scratch, notDef, { x: 0, y: i * 60 });
      addrPorts.push(inv.in);
      matchBits.push(inv.out);
    }
  }

  let acc = matchBits[0]!;
  for (let i = 1; i < matchBits.length; i++) {
    const g = placeAnd(scratch, andDef, { x: 200 + i * 50, y: 0 });
    wire(scratch, acc, g.a);
    wire(scratch, matchBits[i]!, g.b);
    acc = g.out;
  }

  const withIorq = placeAnd(scratch, andDef, { x: 700, y: 80 });
  wire(scratch, acc, withIorq.a);
  const withWr = placeAnd(scratch, andDef, { x: 900, y: 80 });
  wire(scratch, withIorq.out, withWr.a);
  const withD0 = placeAnd(scratch, andDef, { x: 1100, y: 80 });
  wire(scratch, withWr.out, withD0.a);

  return foldExposing(scratch, 'LAB_LED_DECODE', library, [
    ...addrPorts.map((pin, i) => ({ pin, isOutput: false, portName: `a${i}` })),
    { pin: withIorq.b, isOutput: false, portName: 'iorq' },
    { pin: withWr.b, isOutput: false, portName: 'wr' },
    { pin: withD0.b, isOutput: false, portName: 'd0' },
    { pin: withD0.out, isOutput: true, portName: 'out' },
  ]);
}

function getLabLedDecodeChip(library: ChipLibrary): ChipDef {
  let def = labLedDecodeDefs.get(library);
  if (!def) {
    def = library.findByName('LAB_LED_DECODE') ?? makeLabLedDecodeChip(library);
    labLedDecodeDefs.set(library, def);
  }
  return def;
}

/**
 * Place `LAB_LED_DECODE` wired to `cpu` I/O / bus taps.
 * Returns the decode output pin (also labeled `LAB_LED_GATE`).
 */
export function placeLabLedGateDecode(
  circuit: Circuit,
  library: ChipLibrary,
  cpu: Z80Cpu,
  pos: Point,
): Pin {
  const def = getLabLedDecodeChip(library);
  const inst = makeChipInstance(circuit, def, pos);
  for (let i = 0; i < 8; i++) {
    wire(circuit, cpu.ioPortAddr[i]!, inst.pins[`a${i}`]!);
  }
  wire(circuit, cpu.iorq, inst.pins.iorq!);
  wire(circuit, cpu.wr, inst.pins.wr!);
  wire(circuit, cpu.ioPortDataOut[0]!, inst.pins.d0!);
  const out = inst.pins.out!;
  const probe = makeProbe(circuit, { x: pos.x + 120, y: pos.y + 40 }, 'LAB_LED_GATE');
  wire(circuit, out, probe.pins.in);
  const lbl = makeLabel(circuit, 'LAB_LED_GATE', {
    x: pos.x + 140,
    y: pos.y + 20,
  });
  wire(circuit, out, lbl.pins.net);
  return out;
}
