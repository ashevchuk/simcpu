// Factory helpers for building components and small well-known circuits
// (NOT, NAND, AND, SR latch) directly from transistors. These are used by
// the engine's unit tests, and are the same building blocks the future
// palette UI will expose — a gate is nothing more than a saved transistor
// netlist here, no separate "gate" primitive exists in the simulator core.

import type { ChipDef } from './ChipLibrary.js';
import { Circuit, nextId } from './Circuit.js';
import type {
  ChipInstanceComponent,
  InputComponent,
  LabelComponent,
  Pin,
  Point,
  PortComponent,
  ProbeComponent,
  RamComponent,
  SourceComponent,
  TransistorComponent,
  TransistorType,
} from './types.js';

function pin(componentId: string, name: string, pos: Point, dx: number, dy: number): Pin {
  return {
    id: componentId + ':' + name,
    componentId,
    name,
    pos: { x: pos.x + dx, y: pos.y + dy },
  };
}

/** Precomputed pin dy offsets for makeChipInstance — keyed by port count. */
const chipPinDyByCount: number[][] = [];
function chipPinDys(portCount: number): number[] {
  let dys = chipPinDyByCount[portCount];
  if (dys) return dys;
  dys = new Array(portCount);
  const mid = (portCount - 1) / 2;
  for (let i = 0; i < portCount; i++) dys[i] = (i - mid) * 20;
  chipPinDyByCount[portCount] = dys;
  return dys;
}

/**
 * Per-circuit VCC/GND pins for railPin() when a caller needs a wireable Pin
 * on the rail (e.g. mux in1 = 0). Prefer an existing Source; else one Label.
 */
const circuitRailPins = new WeakMap<Circuit, { VCC?: Pin; GND?: Pin }>();

function getCircuitRailPin(circuit: Circuit, rail: 'VCC' | 'GND', at: Point): Pin {
  let cached = circuitRailPins.get(circuit);
  if (!cached) {
    cached = {};
    circuitRailPins.set(circuit, cached);
  }
  const hit = cached[rail];
  if (hit) return hit;

  const want = rail === 'VCC' ? 1 : 0;
  for (const c of circuit.components.values()) {
    if (c.kind === 'source' && c.value === want) {
      cached[rail] = c.pins.out;
      return c.pins.out;
    }
  }
  const lbl = makeLabel(circuit, rail, at);
  cached[rail] = lbl.pins.net;
  return lbl.pins.net;
}

// Fixed pin offsets from a component's center, shared by the factories below
// and by the UI (rendering + pin hit-testing use the exact same geometry).
// v1 has no drag-to-move: a component's pins are fixed at creation time.
export const LAYOUT = {
  transistor: { gate: [-20, 0], drain: [0, -20], source: [0, 20] },
  source: { out: [0, 15] },
  input: { out: [15, 0] },
  probe: { in: [-15, 0] },
  label: { net: [0, 0] },
} as const;

export function makeTransistor(
  circuit: Circuit,
  type: TransistorType,
  pos: Point = { x: 0, y: 0 },
): TransistorComponent {
  const id = nextId('t');
  const x = pos.x;
  const y = pos.y;
  // Inline fixed LAYOUT.transistor offsets — hot path for every gate builder.
  const c: TransistorComponent = {
    id,
    kind: 'transistor',
    type,
    pos,
    rotation: 0,
    pins: {
      gate: { id: id + ':gate', componentId: id, name: 'gate', pos: { x: x - 20, y } },
      drain: { id: id + ':drain', componentId: id, name: 'drain', pos: { x, y: y - 20 } },
      source: { id: id + ':source', componentId: id, name: 'source', pos: { x, y: y + 20 } },
    },
  };
  circuit.addComponent(c);
  return c;
}

export function makeSource(
  circuit: Circuit,
  value: 0 | 1,
  pos: Point = { x: 0, y: 0 },
): SourceComponent {
  const id = nextId('src');
  const c: SourceComponent = {
    id,
    kind: 'source',
    value,
    pos,
    pins: { out: pin(id, 'out', pos, ...LAYOUT.source.out) },
  };
  circuit.addComponent(c);
  return c;
}

export function makeInput(
  circuit: Circuit,
  value: 0 | 1 = 0,
  pos: Point = { x: 0, y: 0 },
): InputComponent {
  const id = nextId('in');
  const c: InputComponent = {
    id,
    kind: 'input',
    value,
    pos,
    pins: { out: pin(id, 'out', pos, ...LAYOUT.input.out) },
  };
  circuit.addComponent(c);
  return c;
}

export function makeLabel(circuit: Circuit, name: string, pos: Point = { x: 0, y: 0 }): LabelComponent {
  const id = nextId('lbl');
  const c: LabelComponent = {
    id,
    kind: 'label',
    name,
    pos,
    pins: {
      net: { id: id + ':net', componentId: id, name: 'net', pos: { x: pos.x, y: pos.y } },
    },
  };
  circuit.addComponent(c);
  return c;
}

/**
 * Attach a pin to the global VCC or GND rail — same computeNets() join that
 * Source(1)/Source(0) and Label("VCC"|"GND") share. Reuses one Source (or,
 * if none exist yet, one Label) per rail per circuit so Z80 place does not
 * allocate tens of thousands of stub Labels. Electrically identical; wires
 * may span to the shared rail pin. The circuit still needs at least one
 * Source(1) and Source(0) somewhere to *drive* the rail.
 */
export function tiePowerRail(circuit: Circuit, rail: 'VCC' | 'GND', p: Pin): void {
  wire(circuit, p, getCircuitRailPin(circuit, rail, p.pos));
}

/** A pin already on the VCC/GND rail — use when you need a Pin value (e.g. mux in1 = 0) without reaching for a distant Source. */
export function railPin(circuit: Circuit, rail: 'VCC' | 'GND', pos: Point): Pin {
  return getCircuitRailPin(circuit, rail, pos);
}

export function makeProbe(circuit: Circuit, pos: Point = { x: 0, y: 0 }, label?: string): ProbeComponent {
  const id = nextId('probe');
  const c: ProbeComponent = {
    id,
    kind: 'probe',
    label,
    pos,
    pins: { in: pin(id, 'in', pos, ...LAYOUT.probe.in) },
  };
  circuit.addComponent(c);
  return c;
}

export function wire(circuit: Circuit, a: Pin, b: Pin): void {
  circuit.addWire(a.id, b.id);
}

/** Boundary marker inside a ChipDef's internal circuit — see fold() in hierarchy.ts. */
export function makePort(circuit: Circuit, name: string, pos: Point = { x: 0, y: 0 }): PortComponent {
  const id = nextId('port');
  const c: PortComponent = { id, kind: 'port', name, pos, pins: { io: pin(id, 'io', pos, 0, 0) } };
  circuit.addComponent(c);
  return c;
}

/** Fixed visual width of every chip instance box. Height depends on port count — see chipInstanceHeight(). */
export const CHIP_INSTANCE_WIDTH = 60;

/**
 * Visual height of a chip instance box with `portCount` pins, stacked at
 * 20 world units apart with a 10-unit margin (matches the pin layout in
 * makeChipInstance below). The one formula geometry.ts's hit-testing,
 * Renderer.ts's drawing, and anything placing several instances in a row
 * (blocks.ts) all need to agree on, so it lives here once.
 */
export function chipInstanceHeight(portCount: number): number {
  return Math.max(portCount, 1) * 20 + 10;
}

/**
 * Place one instance of a chip definition. Pins are stacked vertically
 * along the instance's left edge, in `def.ports` order, centered on `pos`.
 */
export function makeChipInstance(circuit: Circuit, def: ChipDef, pos: Point = { x: 0, y: 0 }): ChipInstanceComponent {
  const id = nextId('chip');
  const ports = def.ports;
  const n = ports.length;
  const dys = chipPinDys(n);
  const pins: Record<string, Pin> = {};
  const px = pos.x - 40;
  const py = pos.y;
  for (let i = 0; i < n; i++) {
    const name = ports[i]!;
    pins[name] = {
      id: id + ':' + name,
      componentId: id,
      name,
      pos: { x: px, y: py + dys[i]! },
    };
  }
  const c: ChipInstanceComponent = { id, kind: 'chip', defId: def.id, pos, pins };
  circuit.addComponent(c);
  return c;
}

/**
 * A behavioral read/write memory — see RamComponent's own doc comment in
 * types.ts for what makes this a deliberate exception to "everything is a
 * transistor," and solver.ts for how `bytes` actually gets read and
 * written. `addrBits` bits of address (so `2 ** addrBits` bytes of
 * storage), `dataBits` bits per word (8, matching this project's IR/ALU
 * width, unless a caller has a real reason to want otherwise). `initial`
 * pre-loads specific bytes (e.g. a tiny hand-written program); anything
 * past its length, or omitted entirely, starts at 0.
 *
 * Pins are laid out stacked vertically, `addr0..addr{N-1}` then
 * `data0..data{M-1}` then `we`/`oe`/`clk`, the same 20-units-apart spacing
 * `makeChipInstance` uses, so it draws the same size box `chipInstanceHeight`
 * already computes — even though this is a raw component, not a folded
 * chip. RAM can't safely be folded into a reusable, independently-
 * instantiable `ChipDef` at all (see ARCHITECTURE.md's "Real RAM" for why),
 * so it borrows the *visual* convention without the hierarchy machinery.
 */
export function makeRam(
  circuit: Circuit,
  addrBits: number,
  dataBits = 8,
  initial?: Uint8Array,
  pos: Point = { x: 0, y: 0 },
): RamComponent {
  if (addrBits < 1) throw new Error('makeRam needs at least one address bit');
  const id = nextId('ram');
  const size = 1 << addrBits;
  const bytes = new Uint8Array(size);
  if (initial) bytes.set(initial.subarray(0, Math.min(initial.length, size)));

  const portCount = addrBits + dataBits + 3; // + we, oe, clk
  const n = portCount;
  let i = 0;
  const nextDy = () => (i++ - (n - 1) / 2) * 20;

  const pins: Record<string, Pin> = {};
  for (let k = 0; k < addrBits; k++) pins[`addr${k}`] = pin(id, `addr${k}`, pos, -40, nextDy());
  for (let k = 0; k < dataBits; k++) pins[`data${k}`] = pin(id, `data${k}`, pos, -40, nextDy());
  pins.we = pin(id, 'we', pos, -40, nextDy());
  pins.oe = pin(id, 'oe', pos, -40, nextDy());
  pins.clk = pin(id, 'clk', pos, -40, nextDy());

  const c: RamComponent = { id, kind: 'ram', addrBits, dataBits, bytes, pos, pins };
  circuit.addComponent(c);
  return c;
}

/** `addr0..addr{N-1}` as an ordered array, LSB first — see RamComponent's doc comment for why `pins` itself stays a flat, unordered Record. */
export function ramAddrPins(c: RamComponent): Pin[] {
  return Array.from({ length: c.addrBits }, (_, i) => c.pins[`addr${i}`]!);
}

/** `data0..data{M-1}` as an ordered array, LSB first. */
export function ramDataPins(c: RamComponent): Pin[] {
  return Array.from({ length: c.dataBits }, (_, i) => c.pins[`data${i}`]!);
}

/** Total pin count of a RamComponent, for sizing its box the same way chipInstanceHeight() sizes a chip instance's. */
export function ramPortCount(c: RamComponent): number {
  return c.addrBits + c.dataBits + 3; // + we, oe, clk
}

/** A single input pin exposed as the gate of a CMOS inverter. */
export interface NotGate {
  in: Pin;
  out: Pin;
}

export interface TwoInputGate {
  a: Pin;
  b: Pin;
  out: Pin;
}

/**
 * Optional per-circuit gate placers. When set (see `setCircuitGatePlacer`),
 * `buildAnd`/`buildOr`/`buildNot`/… place chip instances instead of inline
 * transistors — used by `buildZ80Cpu` to keep place-time netlists hierarchical.
 * Scratch circuits used while folding stdcells never set a placer, so their
 * guts stay real transistors.
 */
export interface CircuitGatePlacer {
  not: (circuit: Circuit, pos: Point) => NotGate;
  nand: (circuit: Circuit, pos: Point) => TwoInputGate;
  and: (circuit: Circuit, pos: Point) => TwoInputGate;
  nor: (circuit: Circuit, pos: Point) => TwoInputGate;
  or: (circuit: Circuit, pos: Point) => TwoInputGate;
  xor: (circuit: Circuit, pos: Point) => TwoInputGate;
}

const circuitGatePlacers = new WeakMap<Circuit, CircuitGatePlacer>();

/** Attach or clear chip-backed gate placement for one circuit. */
export function setCircuitGatePlacer(circuit: Circuit, placer: CircuitGatePlacer | null): void {
  if (placer) circuitGatePlacers.set(circuit, placer);
  else circuitGatePlacers.delete(circuit);
}

/** Standard 2-transistor CMOS inverter: PMOS pulls up, NMOS pulls down. */
export function buildNot(
  circuit: Circuit,
  pos: Point = { x: 0, y: 0 },
): NotGate {
  const placer = circuitGatePlacers.get(circuit);
  if (placer) return placer.not(circuit, pos);

  const pmos = makeTransistor(circuit, 'P', pos);
  const nmos = makeTransistor(circuit, 'N', { x: pos.x, y: pos.y + 60 });
  // Power via rail labels — see tiePowerRail. Circuit still needs Source(1)/Source(0) rail drivers.
  tiePowerRail(circuit, 'VCC', pmos.pins.source);
  tiePowerRail(circuit, 'GND', nmos.pins.source);
  wire(circuit, pmos.pins.drain, nmos.pins.drain);
  wire(circuit, pmos.pins.gate, nmos.pins.gate);
  return { in: pmos.pins.gate, out: pmos.pins.drain };
}

/** Standard CMOS NAND: two PMOS in parallel (pull-up), two NMOS in series (pull-down). */
export function buildNand(
  circuit: Circuit,
  pos: Point = { x: 0, y: 0 },
): TwoInputGate {
  const placer = circuitGatePlacers.get(circuit);
  if (placer) return placer.nand(circuit, pos);

  const p1 = makeTransistor(circuit, 'P', pos);
  const p2 = makeTransistor(circuit, 'P', { x: pos.x + 50, y: pos.y });
  const n1 = makeTransistor(circuit, 'N', { x: pos.x, y: pos.y + 60 });
  const n2 = makeTransistor(circuit, 'N', { x: pos.x + 50, y: pos.y + 60 });

  tiePowerRail(circuit, 'VCC', p1.pins.source);
  tiePowerRail(circuit, 'VCC', p2.pins.source);
  wire(circuit, p1.pins.drain, p2.pins.drain);
  wire(circuit, p1.pins.drain, n1.pins.drain);
  wire(circuit, n1.pins.source, n2.pins.drain);
  tiePowerRail(circuit, 'GND', n2.pins.source);

  wire(circuit, p1.pins.gate, n1.pins.gate); // input A
  wire(circuit, p2.pins.gate, n2.pins.gate); // input B

  return { a: p1.pins.gate, b: p2.pins.gate, out: p1.pins.drain };
}

/** NAND followed by an inverter. */
export function buildAnd(circuit: Circuit, pos: Point = { x: 0, y: 0 }): TwoInputGate {
  const placer = circuitGatePlacers.get(circuit);
  if (placer) return placer.and(circuit, pos);

  const nand = buildNand(circuit, pos);
  const inv = buildNot(circuit, { x: pos.x + 120, y: pos.y });
  wire(circuit, nand.out, inv.in);
  return { a: nand.a, b: nand.b, out: inv.out };
}

/** Standard CMOS NOR: two PMOS in series (pull-up), two NMOS in parallel (pull-down) — the dual of NAND. */
export function buildNor(
  circuit: Circuit,
  pos: Point = { x: 0, y: 0 },
): TwoInputGate {
  const placer = circuitGatePlacers.get(circuit);
  if (placer) return placer.nor(circuit, pos);

  const p1 = makeTransistor(circuit, 'P', pos);
  const p2 = makeTransistor(circuit, 'P', { x: pos.x, y: pos.y + 60 });
  const n1 = makeTransistor(circuit, 'N', { x: pos.x + 50, y: pos.y });
  const n2 = makeTransistor(circuit, 'N', { x: pos.x + 50, y: pos.y + 60 });

  tiePowerRail(circuit, 'VCC', p1.pins.source);
  wire(circuit, p1.pins.drain, p2.pins.source);
  wire(circuit, p2.pins.drain, n1.pins.drain);
  wire(circuit, n1.pins.drain, n2.pins.drain);
  tiePowerRail(circuit, 'GND', n1.pins.source);
  tiePowerRail(circuit, 'GND', n2.pins.source);

  wire(circuit, p1.pins.gate, n1.pins.gate); // input A
  wire(circuit, p2.pins.gate, n2.pins.gate); // input B

  return { a: p1.pins.gate, b: p2.pins.gate, out: p2.pins.drain };
}

/** NOR followed by an inverter. */
export function buildOr(circuit: Circuit, pos: Point = { x: 0, y: 0 }): TwoInputGate {
  const placer = circuitGatePlacers.get(circuit);
  if (placer) return placer.or(circuit, pos);

  const nor = buildNor(circuit, pos);
  const inv = buildNot(circuit, { x: pos.x + 120, y: pos.y });
  wire(circuit, nor.out, inv.in);
  return { a: nor.a, b: nor.b, out: inv.out };
}

/**
 * The classic 4-NAND XOR: n1 = NAND(a,b); out = NAND(NAND(a,n1), NAND(b,n1)).
 * Cheaper (16 transistors) than composing it out of AND/OR/NOT (22+), and it
 * keeps XOR built from the same NAND primitive as everything else here.
 */
export function buildXor(circuit: Circuit, pos: Point = { x: 0, y: 0 }): TwoInputGate {
  const placer = circuitGatePlacers.get(circuit);
  if (placer) return placer.xor(circuit, pos);

  const g1 = buildNand(circuit, pos); // n1 = NAND(a, b)
  const g2 = buildNand(circuit, { x: pos.x, y: pos.y + 150 }); // NAND(a, n1)
  const g3 = buildNand(circuit, { x: pos.x + 150, y: pos.y + 150 }); // NAND(b, n1)
  const g4 = buildNand(circuit, { x: pos.x + 150, y: pos.y + 300 }); // out

  wire(circuit, g1.a, g2.a); // both driven by external input a
  wire(circuit, g1.b, g3.a); // both driven by external input b
  wire(circuit, g1.out, g2.b);
  wire(circuit, g1.out, g3.b);
  wire(circuit, g2.out, g4.a);
  wire(circuit, g3.out, g4.b);

  return { a: g1.a, b: g1.b, out: g4.out };
}

export interface Mux2 {
  sel: Pin;
  in0: Pin;
  in1: Pin;
  out: Pin;
}

/** 2:1 multiplexer: out = sel ? in1 : in0, built from NOT/AND/OR (the standard sum-of-products form). */
export function buildMux2(circuit: Circuit, pos: Point = { x: 0, y: 0 }): Mux2 {
  const notSel = buildNot(circuit, pos);
  const and0 = buildAnd(circuit, { x: pos.x + 150, y: pos.y }); // NOT(sel) AND in0
  const and1 = buildAnd(circuit, { x: pos.x + 150, y: pos.y + 150 }); // sel AND in1
  const or = buildOr(circuit, { x: pos.x + 350, y: pos.y + 75 });

  wire(circuit, notSel.out, and0.a);
  wire(circuit, notSel.in, and1.a); // shares the raw `sel` signal
  wire(circuit, and0.out, or.a);
  wire(circuit, and1.out, or.b);

  return { sel: notSel.in, in0: and0.b, in1: and1.b, out: or.out };
}

export interface HalfAdder {
  a: Pin;
  b: Pin;
  sum: Pin;
  cout: Pin;
}

/**
 * 1-bit half adder: sum = a ^ b, cout = a & b — no carry-in, unlike
 * buildFullAdder. Its main use isn't summing two arbitrary bits so much as
 * being the cell an N-bit *incrementer* chains: bit i's `b` input is bit
 * i-1's `cout`, with the very first `b` tied to a constant 1 (that's the
 * "+1"). See buildProgramCounter in blocks.ts.
 */
export function buildHalfAdder(circuit: Circuit, pos: Point = { x: 0, y: 0 }): HalfAdder {
  const xor = buildXor(circuit, pos);
  const and = buildAnd(circuit, { x: pos.x, y: pos.y + 500 });
  wire(circuit, xor.a, and.a);
  wire(circuit, xor.b, and.b);
  return { a: xor.a, b: xor.b, sum: xor.out, cout: and.out };
}

export interface FullAdder {
  a: Pin;
  b: Pin;
  cin: Pin;
  sum: Pin;
  cout: Pin;
}

/**
 * 1-bit full adder: sum = a ^ b ^ cin, cout = (a & b) | (cin & (a ^ b)) — the
 * standard two-XOR/two-AND/one-OR form, built entirely from the gates above.
 */
export function buildFullAdder(circuit: Circuit, pos: Point = { x: 0, y: 0 }): FullAdder {
  const xor1 = buildXor(circuit, pos); // a ^ b
  const xor2 = buildXor(circuit, { x: pos.x + 500, y: pos.y }); // (a ^ b) ^ cin = sum
  const and1 = buildAnd(circuit, { x: pos.x, y: pos.y + 500 }); // a & b
  const and2 = buildAnd(circuit, { x: pos.x + 500, y: pos.y + 500 }); // (a ^ b) & cin
  const or1 = buildOr(circuit, { x: pos.x + 900, y: pos.y + 250 }); // cout

  wire(circuit, xor1.a, and1.a); // shared `a`
  wire(circuit, xor1.b, and1.b); // shared `b`
  wire(circuit, xor1.out, xor2.a);
  wire(circuit, xor1.out, and2.a);
  wire(circuit, xor2.b, and2.b); // shared `cin`
  wire(circuit, and1.out, or1.a);
  wire(circuit, and2.out, or1.b);

  return { a: xor1.a, b: xor1.b, cin: xor2.b, sum: xor2.out, cout: or1.out };
}

export interface Mux4 {
  sel0: Pin;
  sel1: Pin;
  in0: Pin;
  in1: Pin;
  in2: Pin;
  in3: Pin;
  out: Pin;
}

/** 4:1 multiplexer, a tree of three buildMux2()s: sel1 picks a half, sel0 picks within it. */
export function buildMux4(circuit: Circuit, pos: Point = { x: 0, y: 0 }): Mux4 {
  const low = buildMux2(circuit, pos); // in0/in1 via sel0
  const high = buildMux2(circuit, { x: pos.x, y: pos.y + 400 }); // in2/in3 via sel0
  const out = buildMux2(circuit, { x: pos.x + 600, y: pos.y + 200 }); // low/high via sel1

  wire(circuit, low.sel, high.sel); // shared sel0
  wire(circuit, low.out, out.in0);
  wire(circuit, high.out, out.in1);

  return { sel0: low.sel, sel1: out.sel, in0: low.in0, in1: low.in1, in2: high.in0, in3: high.in1, out: out.out };
}

export interface TriStateBuffer {
  a: Pin;
  en: Pin;
  out: Pin;
}

/**
 * Non-inverting tri-state bus driver: `out = a` while `en=1`; while `en=0`,
 * `out` is left with no forced driver at all, so the solver's capacitive
 * hold keeps whatever level the bus last saw (see solver.ts's doc comment)
 * instead of snapping to 0 or 1. This — several drivers sharing one wire,
 * at most one enabled at a time — is what an actual bus *is*; without it
 * every "shared" line in a datapath is really just a point-to-point wire.
 *
 * Built as two inversions so the exposed behavior is non-inverting: `inv`
 * computes NOT(a) unconditionally (an ordinary 2-transistor CMOS inverter,
 * always driven); a second, classic 4-transistor tri-state-inverter stage
 * re-inverts `inv.out`, with its outer pull-up (gated by NOT(en)) and
 * pull-down (gated by en) transistors in series with the inner pair. When
 * en=0 both outer transistors are cut off regardless of `a` — neither VCC
 * nor GND reaches `out` through any path, which is exactly the tri-state
 * condition, using nothing but ordinary switch-level transistors already
 * modeled by the solver.
 */
export function buildTriStateBuffer(
  circuit: Circuit,
  pos: Point = { x: 0, y: 0 },
): TriStateBuffer {
  const inv = buildNot(circuit, pos); // inv.out = NOT(a)
  const enInv = buildNot(circuit, { x: pos.x + 200, y: pos.y }); // enInv.out = NOT(en)

  const p1 = makeTransistor(circuit, 'P', { x: pos.x + 100, y: pos.y + 150 });
  const p2 = makeTransistor(circuit, 'P', { x: pos.x + 100, y: pos.y + 210 });
  const n2 = makeTransistor(circuit, 'N', { x: pos.x + 100, y: pos.y + 270 });
  const n1 = makeTransistor(circuit, 'N', { x: pos.x + 100, y: pos.y + 330 });

  tiePowerRail(circuit, 'VCC', p1.pins.source);
  wire(circuit, p1.pins.gate, enInv.out); // pull-up path open when en=1
  wire(circuit, p1.pins.drain, p2.pins.source);
  wire(circuit, p2.pins.gate, inv.out); // pulls up when a=1

  wire(circuit, n2.pins.drain, p2.pins.drain); // the shared output node
  wire(circuit, n2.pins.gate, inv.out); // pulls down when a=0
  wire(circuit, n2.pins.source, n1.pins.drain);
  wire(circuit, n1.pins.gate, enInv.in); // pull-down path open when en=1
  tiePowerRail(circuit, 'GND', n1.pins.source);

  return { a: inv.in, en: enInv.in, out: p2.pins.drain };
}

export interface Decoder {
  addr: Pin[];
  lines: Pin[]; // one-hot: lines[i] is high exactly when addr reads i
}

/**
 * One-hot address decoder: `bits` address inputs (which this function
 * creates and exposes as `addr`, the same "build your own sink pins and
 * return them" shape every other builder in this file uses — never take an
 * already-driven pin as a parameter, or a caller who wires their own driver
 * into it creates a second, silently-conflicting driver on top of whatever
 * already forces that net) in, `2**bits` mutually exclusive select lines
 * out — exactly one high for any given address, the standard job of
 * picking which word of a memory (or which driver of a bus) is "this one"
 * this cycle. Built from one buildNot per address bit plus one buildAnd per
 * extra bit each output line needs (line `i` is the AND of `addr[k]` or
 * `NOT(addr[k])` for every bit `k`, chosen by `i`'s own binary pattern) — a
 * two-level AND-of-(true-or-complemented)-inputs decoder, no shortcuts.
 */
export function buildDecoder(circuit: Circuit, bits: number, pos: Point = { x: 0, y: 0 }): Decoder {
  if (bits < 1) throw new Error('buildDecoder needs at least one address bit');

  const inv: NotGate[] = Array.from({ length: bits }, (_, i) => buildNot(circuit, { x: pos.x, y: pos.y + i * 100 }));
  const addr = inv.map((g) => g.in); // the raw bit, used directly as a "1" term below
  const notAddr = inv.map((g) => g.out); // its complement, used as a "0" term below

  const lines: Pin[] = [];
  const count = 1 << bits;
  for (let i = 0; i < count; i++) {
    let term: Pin = (i & 1) === 1 ? addr[0]! : notAddr[0]!;
    for (let k = 1; k < bits; k++) {
      const next = (i & (1 << k)) !== 0 ? addr[k]! : notAddr[k]!;
      const and = buildAnd(circuit, { x: pos.x + 200 + k * 250, y: pos.y + i * 150 });
      wire(circuit, and.a, term);
      wire(circuit, and.b, next);
      term = and.out;
    }
    lines.push(term);
  }
  return { addr, lines };
}

export interface SrLatch {
  setPin: Pin;
  resetPin: Pin;
  q: Pin;
  qn: Pin;
}

/**
 * The classic NAND SR latch: two cross-coupled NANDs with active-low
 * set/reset — each gate's output feeds the other gate's second input,
 * which is exactly the feedback loop the solver's relaxation loop exists
 * to resolve.
 */
export function buildSrLatch(circuit: Circuit, pos: Point = { x: 0, y: 0 }): SrLatch {
  const g1 = buildNand(circuit, pos); // Q  = NAND(setPin_n, qn)
  const g2 = buildNand(circuit, { x: pos.x, y: pos.y + 150 }); // Qn = NAND(resetPin_n, q)
  wire(circuit, g1.out, g2.b);
  wire(circuit, g2.out, g1.b);
  return { setPin: g1.a, resetPin: g2.a, q: g1.out, qn: g2.out };
}
