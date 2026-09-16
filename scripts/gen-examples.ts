/**
 * Build demo project JSON files under examples/.
 * Run: npx vite-node scripts/gen-examples.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import {
  buildNot,
  buildXor,
  makeButton,
  makeChipInstance,
  makeClock,
  makeInput,
  makeLed,
  makeProbe,
  makeRom,
  makeSevenSeg,
  makeSource,
  wire,
} from '../src/sim/library.js';
import { serializeProject, type SerializedProject } from '../src/sim/serialize.js';
import { seedStandardCells } from '../src/sim/stdcells.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples');
mkdirSync(outDir, { recursive: true });

/** Project JSON with only chip defs referenced from the top circuit (easy to edit). */
function serializeUsed(top: Circuit, library: ChipLibrary): SerializedProject {
  const full = serializeProject(top, library);
  const used = new Set<string>();
  const visitCircuit = (circuit: Circuit): void => {
    for (const c of circuit.components.values()) {
      if (c.kind !== 'chip') continue;
      if (used.has(c.defId)) continue;
      used.add(c.defId);
      visitCircuit(library.get(c.defId).circuit);
    }
  };
  visitCircuit(top);
  return { ...full, chipDefs: full.chipDefs.filter((d) => used.has(d.id)) };
}

function emptyLib(): ChipLibrary {
  const library = new ChipLibrary();
  seedStandardCells(library);
  return library;
}

function write(name: string, top: Circuit, library: ChipLibrary): void {
  const path = join(outDir, `${name}.json`);
  const data = serializeUsed(top, library);
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  console.log('wrote', path, `(${data.chipDefs.length} chip defs)`);
}

/** Button → CMOS inverter → LED + probe (transistor-level). */
function cmosInverter(): void {
  const library = emptyLib();
  const c = new Circuit();
  makeSource(c, 1, { x: 60, y: 40 });
  makeSource(c, 0, { x: 60, y: 160 });
  const btn = makeButton(c, { x: 140, y: 100 }, 'toggle');
  const inv = buildNot(c, { x: 260, y: 70 });
  const led = makeLed(c, { x: 420, y: 100 }, 'out');
  const probe = makeProbe(c, { x: 420, y: 160 }, 'out');
  wire(c, btn.pins.out, inv.in);
  wire(c, inv.out, led.pins.in);
  wire(c, inv.out, probe.pins.in);
  write('cmos-inverter', c, library);
}

/** Two toggles → Library NAND chip → LED. */
function nandGate(): void {
  const library = emptyLib();
  const def = library.findByName('NAND')!;
  const c = new Circuit();
  const a = makeButton(c, { x: 120, y: 60 }, 'toggle');
  const b = makeButton(c, { x: 120, y: 140 }, 'toggle');
  const chip = makeChipInstance(c, def, { x: 280, y: 100 });
  const led = makeLed(c, { x: 440, y: 100 }, 'nand');
  wire(c, a.pins.out, chip.pins.a!);
  wire(c, b.pins.out, chip.pins.b!);
  wire(c, chip.pins.out!, led.pins.in);
  write('nand-gate', c, library);
}

/** Half adder from Library cell + LEDs for sum / carry. */
function halfAdder(): void {
  const library = emptyLib();
  const def = library.findByName('HALF_ADDER')!;
  const c = new Circuit();
  const a = makeButton(c, { x: 120, y: 60 }, 'toggle');
  const b = makeButton(c, { x: 120, y: 140 }, 'toggle');
  const chip = makeChipInstance(c, def, { x: 280, y: 100 });
  const sum = makeLed(c, { x: 460, y: 60 }, 'sum');
  const cout = makeLed(c, { x: 460, y: 140 }, 'cout');
  wire(c, a.pins.out, chip.pins.a!);
  wire(c, b.pins.out, chip.pins.b!);
  wire(c, chip.pins.sum!, sum.pins.in);
  wire(c, chip.pins.cout!, cout.pins.in);
  write('half-adder', c, library);
}

/** D latch walkthrough: D + EN buttons, Q/Qn LEDs (stdcell). Catalog: "Latch walkthrough". */
function dLatch(): void {
  const library = emptyLib();
  const def = library.findByName('D_LATCH')!;
  const c = new Circuit();
  const d = makeButton(c, { x: 120, y: 60 }, 'toggle');
  const en = makeButton(c, { x: 120, y: 140 }, 'momentary');
  const chip = makeChipInstance(c, def, { x: 280, y: 120 });
  const q = makeLed(c, { x: 460, y: 60 }, 'Q');
  const qn = makeLed(c, { x: 460, y: 160 }, 'Qn');
  wire(c, d.pins.out, chip.pins.d!);
  wire(c, en.pins.out, chip.pins.en!);
  wire(c, chip.pins.q!, q.pins.in);
  wire(c, chip.pins.qn!, qn.pins.in);
  write('d-latch', c, library);
}

/** Tiny ROM with a greeting string; OE tied high; probes on D0–D7. */
function romDump(): void {
  const library = emptyLib();
  const c = new Circuit();
  const hello = new TextEncoder().encode('Hello!\nZ80\0');
  const rom = makeRom(c, 8, 8, hello, { x: 320, y: 180 });
  const oe = makeInput(c, 1, { x: 160, y: 300 });
  wire(c, oe.pins.out, rom.pins.oe!);
  for (let i = 0; i < 8; i++) {
    const inp = makeInput(c, 0, { x: 160, y: 40 + i * 28 });
    wire(c, inp.pins.out, rom.pins[`addr${i}`]!);
  }
  for (let i = 0; i < 8; i++) {
    const p = makeProbe(c, { x: 480, y: 60 + i * 28 }, `D${i}`);
    wire(c, rom.pins[`data${i}`]!, p.pins.in);
  }
  write('rom-viewer', c, library);
}

/** XOR from raw transistors + clocked pulse into one input (lab instruments). */
function xorPulse(): void {
  const library = emptyLib();
  const c = new Circuit();
  makeSource(c, 1, { x: 40, y: 40 });
  makeSource(c, 0, { x: 40, y: 220 });
  const a = makeButton(c, { x: 140, y: 60 }, 'toggle');
  const clk = makeClock(c, { x: 140, y: 160 }, 30);
  clk.running = true;
  const xor = buildXor(c, { x: 300, y: 80 });
  const led = makeLed(c, { x: 520, y: 120 }, 'xor');
  wire(c, a.pins.out, xor.a);
  wire(c, clk.pins.out, xor.b);
  wire(c, xor.out, led.pins.in);
  write('xor-pulse', c, library);
}

/** Nested hierarchy: AND stdcell (dive to see insides). */
function andFromLibrary(): void {
  const library = emptyLib();
  const def = library.findByName('AND')!;
  const c = new Circuit();
  const a = makeButton(c, { x: 120, y: 60 }, 'toggle');
  const b = makeButton(c, { x: 120, y: 140 }, 'toggle');
  const chip = makeChipInstance(c, def, { x: 280, y: 100 });
  const led = makeLed(c, { x: 440, y: 100 }, 'and');
  wire(c, a.pins.out, chip.pins.a!);
  wire(c, b.pins.out, chip.pins.b!);
  wire(c, chip.pins.out!, led.pins.in);
  write('and-gate', c, library);
}

/** COUNTER4 → BCD_7SEG → 7SEG with a free-running clock and sync clear. */
function labShiftCounter(): void {
  const library = emptyLib();
  const counter = library.findByName('COUNTER4')!;
  const bcd = library.findByName('BCD_7SEG')!;
  const c = new Circuit();
  const clr = makeButton(c, { x: 100, y: 80 }, 'toggle');
  clr.value = 1; // start in clear so Q leaves Z on first clocks
  const clk = makeClock(c, { x: 100, y: 180 }, 24);
  clk.running = true;
  const cnt = makeChipInstance(c, counter, { x: 280, y: 160 });
  const dec = makeChipInstance(c, bcd, { x: 500, y: 160 });
  const seg = makeSevenSeg(c, { x: 740, y: 160 });
  wire(c, clr.pins.out, cnt.pins.clr!);
  wire(c, clk.pins.out, cnt.pins.clk!);
  for (let i = 0; i < 4; i++) wire(c, cnt.pins[`q${i}`]!, dec.pins[`d${i}`]!);
  for (const s of ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const) {
    wire(c, dec.pins[s]!, seg.pins[s]!);
  }
  write('lab-shift-counter', c, library);
}

cmosInverter();
nandGate();
halfAdder();
dLatch();
romDump();
xorPulse();
andFromLibrary();
labShiftCounter();
