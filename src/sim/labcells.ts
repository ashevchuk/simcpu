/**
 * Digital-lab composite stdcells (Pack A/B/C) built as a *hierarchy* of
 * already-folded chips (NOT/NAND/D_FF/MUX2/…) via makeChipInstance + wire +
 * foldExposing — not flat thousands of transistors.
 *
 * Call seedLabCells after the primitive seed in seedStandardCells (or ensure
 * NOT/NAND/AND/OR/XOR/MUX2/MUX4/D_LATCH/D_FF/TRI_BUF already exist).
 *
 * SR_LATCH ports s,r are active-high: internally inverted into a classic
 * NAND SR latch (whose raw set/reset are active-low).
 */

import type { ChipDef, ChipLibrary } from './ChipLibrary.js';
import { Circuit } from './Circuit.js';
import { foldExposing } from './hierarchy.js';
import {
  buildDecoder,
  buildSrLatch,
  chipInstanceHeight,
  makeChipInstance,
  makeSource,
  railPin,
  tiePowerRail,
  wire,
} from './library.js';
import type { Pin, Point, PortDir } from './types.js';

function scratch(): Circuit {
  const circuit = new Circuit();
  makeSource(circuit, 1);
  makeSource(circuit, 0);
  return circuit;
}

function requireDef(library: ChipLibrary, name: string): ChipDef {
  const def = library.findByName(name);
  if (!def) throw new Error(`labcells: missing base stdcell "${name}" — call seedStandardCells first`);
  return def;
}

function place(circuit: Circuit, library: ChipLibrary, name: string, pos: Point): ReturnType<typeof makeChipInstance> {
  return makeChipInstance(circuit, requireDef(library, name), pos);
}

function portDirs(def: ChipDef): Map<string, PortDir> {
  const dirs = new Map<string, PortDir>();
  for (const c of def.circuit.components.values()) {
    if (c.kind === 'port') dirs.set(c.name, c.dir ?? 'inout');
  }
  return dirs;
}

function foldIfAbsent(
  library: ChipLibrary,
  name: string,
  build: () => { circuit: Circuit; ports: { pin: Pin; isOutput: boolean; portName: string }[] },
): void {
  if (library.findByName(name)) return;
  const { circuit, ports } = build();
  foldExposing(circuit, name, library, ports, { labelize: true });
}

/** Wrap an existing lab/stdcell under a new display name (74xx aliases, SIPO8, …). */
function aliasChip(library: ChipLibrary, aliasName: string, targetName: string): void {
  if (library.findByName(aliasName)) return;
  const target = library.findByName(targetName);
  if (!target) return;
  const circuit = scratch();
  const inst = makeChipInstance(circuit, target, { x: 200, y: 0 });
  const dirs = portDirs(target);
  const ports = target.ports.map((portName) => ({
    pin: inst.pins[portName]!,
    isOutput: dirs.get(portName) === 'out',
    portName,
  }));
  foldExposing(circuit, aliasName, library, ports, { labelize: true });
}

function notPin(circuit: Circuit, library: ChipLibrary, a: Pin, pos: Point): Pin {
  const g = place(circuit, library, 'NOT', pos);
  wire(circuit, a, g.pins.in!);
  return g.pins.out!;
}

function and2(circuit: Circuit, library: ChipLibrary, a: Pin, b: Pin, pos: Point): Pin {
  const g = place(circuit, library, 'AND', pos);
  wire(circuit, a, g.pins.a!);
  wire(circuit, b, g.pins.b!);
  return g.pins.out!;
}

function or2(circuit: Circuit, library: ChipLibrary, a: Pin, b: Pin, pos: Point): Pin {
  const g = place(circuit, library, 'OR', pos);
  wire(circuit, a, g.pins.a!);
  wire(circuit, b, g.pins.b!);
  return g.pins.out!;
}

function xor2(circuit: Circuit, library: ChipLibrary, a: Pin, b: Pin, pos: Point): Pin {
  const g = place(circuit, library, 'XOR', pos);
  wire(circuit, a, g.pins.a!);
  wire(circuit, b, g.pins.b!);
  return g.pins.out!;
}

function andReduce(circuit: Circuit, library: ChipLibrary, pins: Pin[], pos: Point): Pin {
  if (pins.length === 0) throw new Error('andReduce: empty');
  let acc = pins[0]!;
  for (let i = 1; i < pins.length; i++) {
    acc = and2(circuit, library, acc, pins[i]!, { x: pos.x + i * 140, y: pos.y });
  }
  return acc;
}

function orReduce(circuit: Circuit, library: ChipLibrary, pins: Pin[], pos: Point): Pin {
  if (pins.length === 0) throw new Error('orReduce: empty');
  let acc = pins[0]!;
  for (let i = 1; i < pins.length; i++) {
    acc = or2(circuit, library, acc, pins[i]!, { x: pos.x + i * 140, y: pos.y });
  }
  return acc;
}

/** Display names seeded by seedLabCells (Pack A/B/C + 74xx aliases). */
export const LABCELL_NAMES = new Set([
  // Pack A
  'SR_LATCH',
  'JK_FF',
  'T_FF',
  'REG4',
  'REG8',
  'SHIFT4_SIPO',
  'SHIFT8_SIPO',
  'SHIFT4_PISO',
  'SHIFT8_PISO',
  'COUNTER4',
  'DECODER_2_4',
  'DECODER_3_8',
  'ENCODER_8_3',
  'COMP2',
  'COMP4',
  'BCD_7SEG',
  // Pack B
  'BUF8',
  'INV8',
  'LATCH8',
  'MUX8_1',
  'DEMUX_1_8',
  'SIPO8',
  'PISO8',
  'CLK_DIV16',
  'CLK_DIV2',
  // Pack C — 74xx aliases
  '7400',
  '7404',
  '7408',
  '7432',
  '7486',
  '7474',
  '74157_1',
  '74139',
  '74138',
  '74161',
  '74164',
  '74165',
  '74373',
  '74374',
  '7447',
]);

export function isLabcellName(name: string): boolean {
  return LABCELL_NAMES.has(name);
}

function seedSrLatch(library: ChipLibrary): void {
  foldIfAbsent(library, 'SR_LATCH', () => {
    // Active-high S/R: invert into classic NAND SR (active-low set/reset).
    const circuit = scratch();
    const latch = buildSrLatch(circuit, { x: 400, y: 0 });
    const sPort = place(circuit, library, 'NOT', { x: 80, y: 0 });
    const rPort = place(circuit, library, 'NOT', { x: 80, y: 150 });
    wire(circuit, sPort.pins.out!, latch.setPin);
    wire(circuit, rPort.pins.out!, latch.resetPin);
    return {
      circuit,
      ports: [
        { pin: sPort.pins.in!, isOutput: false, portName: 's' },
        { pin: rPort.pins.in!, isOutput: false, portName: 'r' },
        { pin: latch.q, isOutput: true, portName: 'q' },
        { pin: latch.qn, isOutput: true, portName: 'qn' },
      ],
    };
  });
}

function seedJkFf(library: ChipLibrary): void {
  foldIfAbsent(library, 'JK_FF', () => {
    // D = J&~Q | ~K&Q
    const circuit = scratch();
    const ff = place(circuit, library, 'D_FF', { x: 900, y: 80 });
    const q = ff.pins.q!;
    const qn = ff.pins.qn!;
    const jAnd = place(circuit, library, 'AND', { x: 200, y: 0 });
    const kAnd = place(circuit, library, 'AND', { x: 200, y: 160 });
    const orG = place(circuit, library, 'OR', { x: 500, y: 80 });
    const notKGate = place(circuit, library, 'NOT', { x: 40, y: 160 });
    wire(circuit, qn, jAnd.pins.b!); // J & ~Q
    wire(circuit, notKGate.pins.out!, kAnd.pins.a!); // ~K & Q
    wire(circuit, q, kAnd.pins.b!);
    wire(circuit, jAnd.pins.out!, orG.pins.a!);
    wire(circuit, kAnd.pins.out!, orG.pins.b!);
    wire(circuit, orG.pins.out!, ff.pins.d!);
    return {
      circuit,
      ports: [
        { pin: jAnd.pins.a!, isOutput: false, portName: 'j' },
        { pin: notKGate.pins.in!, isOutput: false, portName: 'k' },
        { pin: ff.pins.clk!, isOutput: false, portName: 'clk' },
        { pin: q, isOutput: true, portName: 'q' },
        { pin: qn, isOutput: true, portName: 'qn' },
      ],
    };
  });
}

function seedTFf(library: ChipLibrary): void {
  foldIfAbsent(library, 'T_FF', () => {
    // D = clr ? 0 : (t ? ~q : q). Sync clear is required: Q starts at Z, so
    // a pure XOR/toggle loop never leaves the floating state in this solver.
    const circuit = scratch();
    const ff = place(circuit, library, 'D_FF', { x: 700, y: 40 });
    const muxT = place(circuit, library, 'MUX2', { x: 200, y: 40 });
    const muxClr = place(circuit, library, 'MUX2', { x: 450, y: 40 });
    // sel=t: in0=hold q, in1=toggle via qn
    wire(circuit, ff.pins.q!, muxT.pins.in0!);
    wire(circuit, ff.pins.qn!, muxT.pins.in1!);
    // sel=clr (active-high): in0=toggle/hold, in1=0
    wire(circuit, muxT.pins.out!, muxClr.pins.in0!);
    wire(circuit, railPin(circuit, 'GND', { x: 360, y: 120 }), muxClr.pins.in1!);
    wire(circuit, muxClr.pins.out!, ff.pins.d!);
    return {
      circuit,
      ports: [
        { pin: muxT.pins.sel!, isOutput: false, portName: 't' },
        { pin: muxClr.pins.sel!, isOutput: false, portName: 'clr' },
        { pin: ff.pins.clk!, isOutput: false, portName: 'clk' },
        { pin: ff.pins.q!, isOutput: true, portName: 'q' },
        { pin: ff.pins.qn!, isOutput: true, portName: 'qn' },
      ],
    };
  });
}

function seedRegisterN(library: ChipLibrary, bits: number, name: string): void {
  foldIfAbsent(library, name, () => {
    const circuit = scratch();
    const dffH = chipInstanceHeight(4) + 30;
    const muxH = chipInstanceHeight(4) + 30;
    const row = Math.max(dffH, muxH);
    const dPins: Pin[] = [];
    const qPins: Pin[] = [];
    let we!: Pin;
    let clk!: Pin;
    for (let i = 0; i < bits; i++) {
      const y = i * row;
      const mux = place(circuit, library, 'MUX2', { x: 80, y });
      const ff = place(circuit, library, 'D_FF', { x: 320, y });
      // sel=we, in0=q (hold), in1=d (load)
      wire(circuit, mux.pins.out!, ff.pins.d!);
      wire(circuit, ff.pins.q!, mux.pins.in0!);
      dPins.push(mux.pins.in1!);
      qPins.push(ff.pins.q!);
      if (i === 0) {
        we = mux.pins.sel!;
        clk = ff.pins.clk!;
      } else {
        wire(circuit, we, mux.pins.sel!);
        wire(circuit, clk, ff.pins.clk!);
      }
    }
    const ports: { pin: Pin; isOutput: boolean; portName: string }[] = [
      { pin: we, isOutput: false, portName: 'we' },
      { pin: clk, isOutput: false, portName: 'clk' },
    ];
    for (let i = 0; i < bits; i++) ports.push({ pin: dPins[i]!, isOutput: false, portName: `d${i}` });
    for (let i = 0; i < bits; i++) ports.push({ pin: qPins[i]!, isOutput: true, portName: `q${i}` });
    return { circuit, ports };
  });
}

function seedShiftSipo(library: ChipLibrary, bits: number, name: string): void {
  foldIfAbsent(library, name, () => {
    const circuit = scratch();
    const row = chipInstanceHeight(4) + 30;
    const qPins: Pin[] = [];
    let clk!: Pin;
    let sin!: Pin;
    let prevQ: Pin | undefined;
    for (let i = 0; i < bits; i++) {
      const ff = place(circuit, library, 'D_FF', { x: 200, y: i * row });
      qPins.push(ff.pins.q!);
      if (i === 0) {
        sin = ff.pins.d!;
        clk = ff.pins.clk!;
      } else {
        wire(circuit, prevQ!, ff.pins.d!);
        wire(circuit, clk, ff.pins.clk!);
      }
      prevQ = ff.pins.q!;
    }
    const ports: { pin: Pin; isOutput: boolean; portName: string }[] = [
      { pin: sin, isOutput: false, portName: 'sin' },
      { pin: clk, isOutput: false, portName: 'clk' },
    ];
    for (let i = 0; i < bits; i++) ports.push({ pin: qPins[i]!, isOutput: true, portName: `q${i}` });
    return { circuit, ports };
  });
}

function seedShiftPiso(library: ChipLibrary, bits: number, name: string): void {
  foldIfAbsent(library, name, () => {
    const circuit = scratch();
    const row = chipInstanceHeight(4) + 40;
    const dPins: Pin[] = [];
    const qPins: Pin[] = [];
    let load!: Pin;
    let clk!: Pin;
    let prevQ: Pin | undefined;
    for (let i = 0; i < bits; i++) {
      const y = i * row;
      const mux = place(circuit, library, 'MUX2', { x: 80, y });
      const ff = place(circuit, library, 'D_FF', { x: 320, y });
      // sel=load, in0=shiftFromPrev, in1=d_i
      wire(circuit, mux.pins.out!, ff.pins.d!);
      dPins.push(mux.pins.in1!);
      qPins.push(ff.pins.q!);
      if (i === 0) {
        // No prior stage — shift in 0 while not loading.
        wire(circuit, railPin(circuit, 'GND', { x: 0, y }), mux.pins.in0!);
        load = mux.pins.sel!;
        clk = ff.pins.clk!;
      } else {
        wire(circuit, prevQ!, mux.pins.in0!);
        wire(circuit, load, mux.pins.sel!);
        wire(circuit, clk, ff.pins.clk!);
      }
      prevQ = ff.pins.q!;
    }
    const ports: { pin: Pin; isOutput: boolean; portName: string }[] = [
      { pin: load, isOutput: false, portName: 'load' },
      { pin: clk, isOutput: false, portName: 'clk' },
    ];
    for (let i = 0; i < bits; i++) ports.push({ pin: dPins[i]!, isOutput: false, portName: `d${i}` });
    ports.push({ pin: qPins[bits - 1]!, isOutput: true, portName: 'sout' });
    for (let i = 0; i < bits; i++) ports.push({ pin: qPins[i]!, isOutput: true, portName: `q${i}` });
    return { circuit, ports };
  });
}

function seedCounter4(library: ChipLibrary): void {
  foldIfAbsent(library, 'COUNTER4', () => {
    // Sync binary up-counter from T_FF: t0=1, t_i = AND of q0..q{i-1}.
    // Shared active-high `clr` loads 0 on the next clock (breaks Z power-up).
    const circuit = scratch();
    const row = chipInstanceHeight(5) + 40;
    const ffs = [];
    for (let i = 0; i < 4; i++) {
      ffs.push(place(circuit, library, 'T_FF', { x: 500, y: i * row }));
    }
    const q = ffs.map((f) => f.pins.q!);
    let clk = ffs[0]!.pins.clk!;
    let clr = ffs[0]!.pins.clr!;
    for (let i = 1; i < 4; i++) {
      wire(circuit, clk, ffs[i]!.pins.clk!);
      wire(circuit, clr, ffs[i]!.pins.clr!);
    }

    // t0 = 1  (always toggle)
    const one = notPin(circuit, library, railPin(circuit, 'GND', { x: 40, y: 0 }), { x: 160, y: 0 });
    wire(circuit, one, ffs[0]!.pins.t!);

    // t1 = q0
    wire(circuit, q[0]!, ffs[1]!.pins.t!);

    // t2 = q0 & q1
    const t2 = and2(circuit, library, q[0]!, q[1]!, { x: 280, y: 2 * row });
    wire(circuit, t2, ffs[2]!.pins.t!);

    // t3 = q0 & q1 & q2
    const t3 = and2(circuit, library, t2, q[2]!, { x: 280, y: 3 * row });
    wire(circuit, t3, ffs[3]!.pins.t!);

    return {
      circuit,
      ports: [
        { pin: clk, isOutput: false, portName: 'clk' },
        { pin: clr, isOutput: false, portName: 'clr' },
        { pin: q[0]!, isOutput: true, portName: 'q0' },
        { pin: q[1]!, isOutput: true, portName: 'q1' },
        { pin: q[2]!, isOutput: true, portName: 'q2' },
        { pin: q[3]!, isOutput: true, portName: 'q3' },
      ],
    };
  });
}

function seedDecoder(library: ChipLibrary, bits: number, name: string): void {
  foldIfAbsent(library, name, () => {
    const circuit = scratch();
    const dec = buildDecoder(circuit, bits, { x: 0, y: 0 });
    const ports: { pin: Pin; isOutput: boolean; portName: string }[] = [];
    for (let i = 0; i < bits; i++) ports.push({ pin: dec.addr[i]!, isOutput: false, portName: `a${i}` });
    for (let i = 0; i < dec.lines.length; i++) {
      ports.push({ pin: dec.lines[i]!, isOutput: true, portName: `y${i}` });
    }
    return { circuit, ports };
  });
}

function seedEncoder83(library: ChipLibrary): void {
  foldIfAbsent(library, 'ENCODER_8_3', () => {
    // Priority encoder: in7 highest. Outputs binary index of highest asserted input.
    const circuit = scratch();
    // Build priority one-hot p[i] = in[i] & ~in[i+1] & … & ~in[7]
    const row = 80;
    const inv: Pin[] = [];
    const inPins: Pin[] = [];
    for (let i = 0; i < 8; i++) {
      const n = place(circuit, library, 'NOT', { x: 40, y: i * row });
      inPins.push(n.pins.in!);
      inv.push(n.pins.out!);
    }
    const p: Pin[] = [];
    for (let i = 0; i < 8; i++) {
      const terms: Pin[] = [inPins[i]!];
      for (let j = i + 1; j < 8; j++) terms.push(inv[j]!);
      p.push(andReduce(circuit, library, terms, { x: 200, y: i * row }));
    }
    // y2 = p4|p5|p6|p7, y1 = p2|p3|p6|p7, y0 = p1|p3|p5|p7
    const y2 = orReduce(circuit, library, [p[4]!, p[5]!, p[6]!, p[7]!], { x: 900, y: 0 });
    const y1 = orReduce(circuit, library, [p[2]!, p[3]!, p[6]!, p[7]!], { x: 900, y: 200 });
    const y0 = orReduce(circuit, library, [p[1]!, p[3]!, p[5]!, p[7]!], { x: 900, y: 400 });
    const ports: { pin: Pin; isOutput: boolean; portName: string }[] = [];
    for (let i = 0; i < 8; i++) ports.push({ pin: inPins[i]!, isOutput: false, portName: `in${i}` });
    ports.push({ pin: y0, isOutput: true, portName: 'y0' });
    ports.push({ pin: y1, isOutput: true, portName: 'y1' });
    ports.push({ pin: y2, isOutput: true, portName: 'y2' });
    return { circuit, ports };
  });
}

function seedComp(library: ChipLibrary, bits: number, name: string): void {
  foldIfAbsent(library, name, () => {
    const circuit = scratch();
    const a: Pin[] = [];
    const b: Pin[] = [];
    const eqBits: Pin[] = [];
    for (let i = 0; i < bits; i++) {
      const y = i * 100;
      const xor = place(circuit, library, 'XOR', { x: 200, y });
      a.push(xor.pins.a!);
      b.push(xor.pins.b!);
      eqBits.push(notPin(circuit, library, xor.pins.out!, { x: 400, y }));
    }
    const eq = andReduce(circuit, library, eqBits, { x: 600, y: 0 });
    const ports: { pin: Pin; isOutput: boolean; portName: string }[] = [];
    for (let i = 0; i < bits; i++) ports.push({ pin: a[i]!, isOutput: false, portName: `a${i}` });
    for (let i = 0; i < bits; i++) ports.push({ pin: b[i]!, isOutput: false, portName: `b${i}` });
    ports.push({ pin: eq, isOutput: true, portName: 'eq' });
    return { circuit, ports };
  });
}

/** BCD digit enable: AND of (d_i or ~d_i) matching `digit` (0–9). */
function bcdDigit(
  circuit: Circuit,
  library: ChipLibrary,
  d: Pin[],
  dInv: Pin[],
  digit: number,
  pos: Point,
): Pin {
  const terms: Pin[] = [];
  for (let i = 0; i < 4; i++) {
    terms.push((digit >> i) & 1 ? d[i]! : dInv[i]!);
  }
  return andReduce(circuit, library, terms, pos);
}

function seedBcd7Seg(library: ChipLibrary): void {
  foldIfAbsent(library, 'BCD_7SEG', () => {
    // Common-cathode active-high segments a..g for digits 0–9.
    const circuit = scratch();
    const d: Pin[] = [];
    const dInv: Pin[] = [];
    for (let i = 0; i < 4; i++) {
      const n = place(circuit, library, 'NOT', { x: 40, y: i * 80 });
      d.push(n.pins.in!);
      dInv.push(n.pins.out!);
    }
    const digits: Pin[] = [];
    for (let dig = 0; dig <= 9; dig++) {
      digits.push(bcdDigit(circuit, library, d, dInv, dig, { x: 200, y: dig * 60 }));
    }
    // Which digits light each segment (common cathode, active high).
    const segMap: Record<string, number[]> = {
      a: [0, 2, 3, 5, 6, 7, 8, 9],
      b: [0, 1, 2, 3, 4, 7, 8, 9],
      c: [0, 1, 3, 4, 5, 6, 7, 8, 9],
      d: [0, 2, 3, 5, 6, 8, 9],
      e: [0, 2, 6, 8],
      f: [0, 4, 5, 6, 8, 9],
      g: [2, 3, 4, 5, 6, 8, 9],
    };
    const segPins: Record<string, Pin> = {};
    let si = 0;
    for (const [seg, digs] of Object.entries(segMap)) {
      const terms = digs.map((n) => digits[n]!);
      segPins[seg] = orReduce(circuit, library, terms, { x: 1100, y: si * 80 });
      si++;
    }
    return {
      circuit,
      ports: [
        { pin: d[0]!, isOutput: false, portName: 'd0' },
        { pin: d[1]!, isOutput: false, portName: 'd1' },
        { pin: d[2]!, isOutput: false, portName: 'd2' },
        { pin: d[3]!, isOutput: false, portName: 'd3' },
        { pin: segPins.a!, isOutput: true, portName: 'a' },
        { pin: segPins.b!, isOutput: true, portName: 'b' },
        { pin: segPins.c!, isOutput: true, portName: 'c' },
        { pin: segPins.d!, isOutput: true, portName: 'd' },
        { pin: segPins.e!, isOutput: true, portName: 'e' },
        { pin: segPins.f!, isOutput: true, portName: 'f' },
        { pin: segPins.g!, isOutput: true, portName: 'g' },
      ],
    };
  });
}

function seedBuf8(library: ChipLibrary): void {
  foldIfAbsent(library, 'BUF8', () => {
    const circuit = scratch();
    const row = chipInstanceHeight(3) + 20;
    const ports: { pin: Pin; isOutput: boolean; portName: string }[] = [];
    for (let i = 0; i < 8; i++) {
      const buf = place(circuit, library, 'TRI_BUF', { x: 200, y: i * row });
      tiePowerRail(circuit, 'VCC', buf.pins.en!);
      ports.push({ pin: buf.pins.a!, isOutput: false, portName: `in${i}` });
      ports.push({ pin: buf.pins.out!, isOutput: true, portName: `out${i}` });
    }
    // Interleave in*/out* by index for readability: rebuild ordered list
    const ordered: typeof ports = [];
    for (let i = 0; i < 8; i++) {
      ordered.push(ports[i * 2]!);
    }
    for (let i = 0; i < 8; i++) {
      ordered.push(ports[i * 2 + 1]!);
    }
    return { circuit, ports: ordered };
  });
}

function seedInv8(library: ChipLibrary): void {
  foldIfAbsent(library, 'INV8', () => {
    const circuit = scratch();
    const row = chipInstanceHeight(2) + 20;
    const ports: { pin: Pin; isOutput: boolean; portName: string }[] = [];
    const outs: typeof ports = [];
    for (let i = 0; i < 8; i++) {
      const g = place(circuit, library, 'NOT', { x: 200, y: i * row });
      ports.push({ pin: g.pins.in!, isOutput: false, portName: `in${i}` });
      outs.push({ pin: g.pins.out!, isOutput: true, portName: `out${i}` });
    }
    return { circuit, ports: [...ports, ...outs] };
  });
}

function seedLatch8(library: ChipLibrary): void {
  foldIfAbsent(library, 'LATCH8', () => {
    const circuit = scratch();
    const row = chipInstanceHeight(4) + 20;
    const dPins: Pin[] = [];
    const qPins: Pin[] = [];
    let en!: Pin;
    for (let i = 0; i < 8; i++) {
      const l = place(circuit, library, 'D_LATCH', { x: 200, y: i * row });
      dPins.push(l.pins.d!);
      qPins.push(l.pins.q!);
      if (i === 0) en = l.pins.en!;
      else wire(circuit, en, l.pins.en!);
    }
    const ports: { pin: Pin; isOutput: boolean; portName: string }[] = [
      { pin: en, isOutput: false, portName: 'en' },
    ];
    for (let i = 0; i < 8; i++) ports.push({ pin: dPins[i]!, isOutput: false, portName: `d${i}` });
    for (let i = 0; i < 8; i++) ports.push({ pin: qPins[i]!, isOutput: true, portName: `q${i}` });
    return { circuit, ports };
  });
}

function seedMux81(library: ChipLibrary): void {
  foldIfAbsent(library, 'MUX8_1', () => {
    const circuit = scratch();
    const lo = place(circuit, library, 'MUX4', { x: 200, y: 0 });
    const hi = place(circuit, library, 'MUX4', { x: 200, y: 280 });
    const top = place(circuit, library, 'MUX2', { x: 500, y: 120 });
    wire(circuit, lo.pins.out!, top.pins.in0!);
    wire(circuit, hi.pins.out!, top.pins.in1!);
    // Share sel0/sel1 across both MUX4
    wire(circuit, lo.pins.sel0!, hi.pins.sel0!);
    wire(circuit, lo.pins.sel1!, hi.pins.sel1!);
    return {
      circuit,
      ports: [
        { pin: lo.pins.sel0!, isOutput: false, portName: 'sel0' },
        { pin: lo.pins.sel1!, isOutput: false, portName: 'sel1' },
        { pin: top.pins.sel!, isOutput: false, portName: 'sel2' },
        { pin: lo.pins.in0!, isOutput: false, portName: 'in0' },
        { pin: lo.pins.in1!, isOutput: false, portName: 'in1' },
        { pin: lo.pins.in2!, isOutput: false, portName: 'in2' },
        { pin: lo.pins.in3!, isOutput: false, portName: 'in3' },
        { pin: hi.pins.in0!, isOutput: false, portName: 'in4' },
        { pin: hi.pins.in1!, isOutput: false, portName: 'in5' },
        { pin: hi.pins.in2!, isOutput: false, portName: 'in6' },
        { pin: hi.pins.in3!, isOutput: false, portName: 'in7' },
        { pin: top.pins.out!, isOutput: true, portName: 'out' },
      ],
    };
  });
}

function seedDemux18(library: ChipLibrary): void {
  foldIfAbsent(library, 'DEMUX_1_8', () => {
    const circuit = scratch();
    let sel: Pin[];
    let lines: Pin[];
    const decDef = library.findByName('DECODER_3_8');
    if (decDef) {
      const inst = makeChipInstance(circuit, decDef, { x: 80, y: 0 });
      sel = [inst.pins.a0!, inst.pins.a1!, inst.pins.a2!];
      lines = Array.from({ length: 8 }, (_, i) => inst.pins[`y${i}`]!);
    } else {
      const dec = buildDecoder(circuit, 3, { x: 0, y: 0 });
      sel = dec.addr;
      lines = dec.lines;
    }
    const outs: Pin[] = [];
    let data!: Pin;
    for (let i = 0; i < 8; i++) {
      const g = place(circuit, library, 'AND', { x: 500, y: i * 100 });
      wire(circuit, lines[i]!, g.pins.a!);
      outs.push(g.pins.out!);
      if (i === 0) data = g.pins.b!;
      else wire(circuit, data, g.pins.b!);
    }
    return {
      circuit,
      ports: [
        { pin: sel[0]!, isOutput: false, portName: 'sel0' },
        { pin: sel[1]!, isOutput: false, portName: 'sel1' },
        { pin: sel[2]!, isOutput: false, portName: 'sel2' },
        { pin: data, isOutput: false, portName: 'in' },
        ...outs.map((p, i) => ({ pin: p, isOutput: true, portName: `y${i}` })),
      ],
    };
  });
}

function seedClkDiv2(library: ChipLibrary): void {
  foldIfAbsent(library, 'CLK_DIV2', () => {
    // ÷2: D=~Q with sync clr so Q can leave Z at power-up.
    const circuit = scratch();
    const ff = place(circuit, library, 'D_FF', { x: 500, y: 40 });
    const notQ = notPin(circuit, library, ff.pins.q!, { x: 200, y: 40 });
    const mux = place(circuit, library, 'MUX2', { x: 320, y: 40 });
    wire(circuit, notQ, mux.pins.in0!); // count: D=~Q
    wire(circuit, railPin(circuit, 'GND', { x: 0, y: 0 }), mux.pins.in1!); // clr → 0
    wire(circuit, mux.pins.out!, ff.pins.d!);
    return {
      circuit,
      ports: [
        { pin: mux.pins.sel!, isOutput: false, portName: 'clr' },
        { pin: ff.pins.clk!, isOutput: false, portName: 'clk' },
        { pin: ff.pins.q!, isOutput: true, portName: 'out' },
      ],
    };
  });
}

function seedClkDiv16(library: ChipLibrary): void {
  foldIfAbsent(library, 'CLK_DIV16', () => {
    const circuit = scratch();
    const c = place(circuit, library, 'COUNTER4', { x: 200, y: 0 });
    return {
      circuit,
      ports: [
        { pin: c.pins.clr!, isOutput: false, portName: 'clr' },
        { pin: c.pins.clk!, isOutput: false, portName: 'clk' },
        { pin: c.pins.q3!, isOutput: true, portName: 'out' },
      ],
    };
  });
}

/**
 * Registers Pack A/B/C lab cells (idempotent by name). Requires primitive
 * stdcells (NOT/NAND/…/D_FF/…) to already be present — seedStandardCells
 * calls this at the end.
 */
export function seedLabCells(library: ChipLibrary): void {
  if (!library.findByName('D_FF') || !library.findByName('NAND') || !library.findByName('MUX2')) {
    return;
  }

  seedSrLatch(library);
  seedJkFf(library);
  seedTFf(library);
  seedRegisterN(library, 4, 'REG4');
  seedRegisterN(library, 8, 'REG8');
  seedShiftSipo(library, 4, 'SHIFT4_SIPO');
  seedShiftSipo(library, 8, 'SHIFT8_SIPO');
  seedShiftPiso(library, 4, 'SHIFT4_PISO');
  seedShiftPiso(library, 8, 'SHIFT8_PISO');
  seedCounter4(library);
  seedDecoder(library, 2, 'DECODER_2_4');
  seedDecoder(library, 3, 'DECODER_3_8');
  seedEncoder83(library);
  seedComp(library, 2, 'COMP2');
  seedComp(library, 4, 'COMP4');
  seedBcd7Seg(library);

  seedBuf8(library);
  seedInv8(library);
  seedLatch8(library);
  seedMux81(library);
  seedDemux18(library);
  seedClkDiv2(library);
  seedClkDiv16(library);

  // Pack B serdes aliases
  aliasChip(library, 'SIPO8', 'SHIFT8_SIPO');
  aliasChip(library, 'PISO8', 'SHIFT8_PISO');

  // Pack C — 74xx-style aliases
  aliasChip(library, '7400', 'NAND');
  aliasChip(library, '7404', 'NOT');
  aliasChip(library, '7408', 'AND');
  aliasChip(library, '7432', 'OR');
  aliasChip(library, '7486', 'XOR');
  aliasChip(library, '7474', 'D_FF');
  aliasChip(library, '74157_1', 'MUX2');
  aliasChip(library, '74139', 'DECODER_2_4');
  aliasChip(library, '74138', 'DECODER_3_8');
  aliasChip(library, '74161', 'COUNTER4');
  aliasChip(library, '74164', 'SHIFT8_SIPO');
  aliasChip(library, '74165', 'SHIFT8_PISO');
  aliasChip(library, '74373', 'LATCH8');
  aliasChip(library, '74374', 'REG8');
  aliasChip(library, '7447', 'BCD_7SEG');
}
