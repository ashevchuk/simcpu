// Core data model for the transistor-level circuit simulator.
//
// The simulator works at the switch level: every net (a maximal group of
// electrically connected pins) carries a logic Level. Transistors are the
// only active devices — everything else (gates, latches, registers, a CPU)
// is built by wiring transistors together, exactly like the reference
// project at cs.khanin.info builds its 6502-like machine from single
// transistors upward.

/** Logic level of a net. 'Z' means floating / not driven by anything. */
export type Level = 0 | 1 | 'Z';

export type TransistorType = 'N' | 'P';

export type ComponentKind =
  | 'transistor'
  | 'source' // fixed driver: VCC (1) or GND (0)
  | 'input' // user-toggleable driver, e.g. a switch
  | 'button' // lab pushbutton: momentary pulse or toggle
  | 'led' // lab indicator — sink only, like probe with a glow
  | 'clock' // configurable pulse generator (continuous or one-shot)
  | 'analyzer' // multi-channel logic analyzer instrument (sense pins)
  | 'tty' // machine TTY / soft console instrument (opens dialog)
  | 'probe' // read-only display of a net's value, no electrical effect
  | 'label' // named net tie point (same name => same net, see Circuit)
  | 'port' // a chip's internal boundary marker, see hierarchy.ts fold()
  | 'chip' // an instance of a reusable ChipDef, see ChipLibrary.ts
  | 'ram' // behavioral read/write memory — see solver.ts's "RAM" section
  | 'rom'; // behavioral read-only memory (OE-gated, no write port)

export interface Point {
  x: number;
  y: number;
}

/** A pin belongs to exactly one component and is a node in the wiring graph. */
export interface Pin {
  id: string; // globally unique: `${componentId}:${pinName}`
  componentId: string;
  name: string; // e.g. 'gate' | 'drain' | 'source' | 'out' | 'a'
  pos: Point; // absolute canvas position, used for rendering & hit-testing
}

export interface TransistorComponent {
  id: string;
  kind: 'transistor';
  type: TransistorType;
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pins: {
    gate: Pin;
    drain: Pin;
    source: Pin;
  };
}

export interface SourceComponent {
  id: string;
  kind: 'source';
  value: 0 | 1; // VCC = 1, GND = 0
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pins: { out: Pin };
}

export interface InputComponent {
  id: string;
  kind: 'input';
  value: 0 | 1;
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pins: { out: Pin };
}

/** Lab pushbutton. Momentary: click drives 1 for `pulseFrames` ticks then 0. Toggle: click flips `value`. */
export interface ButtonComponent {
  id: string;
  kind: 'button';
  mode: 'momentary' | 'toggle';
  value: 0 | 1;
  /** Remaining high frames while pulsing (momentary). */
  holdFrames: number;
  pulseFrames: number;
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pins: { out: Pin };
}

/** Lab LED — electrically a probe; drawn as a glowing indicator. */
export interface LedComponent {
  id: string;
  kind: 'led';
  label?: string;
  color: string; // CSS color for the "on" glow
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pins: { in: Pin };
}

/** Configurable pulse generator — continuous square wave or one-shot pulse. */
export interface ClockComponent {
  id: string;
  kind: 'clock';
  /** continuous: free-run while `running`; oneshot: fire pulseWidth frames on click/TRIG↑. */
  mode: 'continuous' | 'oneshot';
  value: 0 | 1;
  running: boolean;
  /** Full period in animation frames (high+low). Min 2. Used in continuous mode. */
  periodFrames: number;
  /** Frames spent high (1 .. periodFrames-1 continuous; pulse width in oneshot). */
  dutyFrames: number;
  /** Phase counter 0 .. periodFrames-1 (continuous). */
  phase: number;
  /** Remaining high frames while emitting a one-shot pulse. */
  holdFrames: number;
  /** Last sampled TRIG level — rising-edge detect for oneshot / start. */
  lastTrig: 0 | 1 | 'Z';
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pins: { out: Pin; trig: Pin };
}

/** Multi-channel logic analyzer — each `chN` pin is one sense channel. */
export interface AnalyzerComponent {
  id: string;
  kind: 'analyzer';
  channelCount: number;
  armed: boolean;
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pinOrder: string[];
  /** ch0 .. ch{channelCount-1} */
  pins: Record<string, Pin>;
}

/** Machine TTY / console instrument — dblclick opens the floating console. */
export interface TtyComponent {
  id: string;
  kind: 'tty';
  /** Linked RAM id (machine map); null until bound. */
  ramId: string | null;
  pos: Point;
  pins: Record<string, Pin>;
}

export interface ProbeComponent {
  id: string;
  kind: 'probe';
  label?: string;
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pins: { in: Pin };
}

export interface LabelComponent {
  id: string;
  kind: 'label';
  name: string; // nets sharing the same label name are electrically joined
  pos: Point;
  pins: { net: Pin };
}

/**
 * A chip's boundary marker. Ports don't exist as physical hardware — they
 * only mark, inside a ChipDef's internal circuit, which internal pin a
 * given external instance pin corresponds to. flatten() (hierarchy.ts)
 * consumes them and drops them from the simulated netlist entirely.
 *
 * `dir` is editorial (IN/OUT marker in the editor); electrically every port
 * is still a bidirectional `io` pin.
 */
export type PortDir = 'in' | 'out' | 'inout';

export interface PortComponent {
  id: string;
  kind: 'port';
  name: string; // matches one entry of the owning ChipDef's `ports` list
  /** Editor-facing direction; omitted/legacy loads as `'inout'`. */
  dir: PortDir;
  pos: Point;
  pins: { io: Pin };
}

/**
 * One placed instance of a reusable chip (see ChipLibrary.ts). Its pins are
 * dynamic — one per port the folded ChipDef exposes — unlike every other
 * component kind here, which has a fixed, named pin set.
 */
export interface ChipInstanceComponent {
  id: string;
  kind: 'chip';
  defId: string; // ChipDef.id in the ChipLibrary this circuit is edited against
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  /** Port names in stack order (same as ChipDef.ports at place time). */
  pinOrder: string[];
  /**
   * Local pin side per port name: -1 = left, +1 = right (from PortDir:
   * out → right, in/inout → left). Omitted on legacy saves ⇒ all left.
   */
  pinSide?: Record<string, -1 | 1>;
  /** Optional body width override (default CHIP_INSTANCE_WIDTH). */
  boxWidth?: number;
  /** Optional silkscreen text override (default ChipDef name). */
  marking?: string;
  /** ChipDef.revision when this instance was placed or last dived into. */
  defRevision?: number;
  pins: Record<string, Pin>; // keyed by port name
}

/**
 * A behavioral read/write memory — the one deliberate exception to "every
 * active device here is a transistor" (see ARCHITECTURE.md's "Real RAM").
 * `bytes[addr]` is read continuously onto the data pins while `oe=1` (like
 * a wide `buildTriStateBuffer` bank, just backed by a lookup instead of
 * constants); on a `clk` 0->1 edge with `we=1`, the *current* level of the
 * data pins is captured into `bytes[addr]` instead. Both are handled by
 * solver.ts, not by any transistor this component owns — it owns none.
 *
 * `pins` stays a flat `Record<string, Pin>` — `addr0..addr{N-1}`,
 * `data0..data{M-1}`, `we`, `oe`, `clk` — the same invariant every other
 * component here keeps (see hierarchy.ts's `flattenLevel`, which relies on
 * treating any component's `pins` as "a plain object of Pin values"
 * generically). `addrBits`/`dataBits` say how many of each exist; use
 * `ramAddrPins`/`ramDataPins` (library.ts) to get them back as ordered
 * arrays rather than re-deriving the naming convention at each call site.
 *
 * `bytes` is deliberately mutable, mutated in place by solver.ts on a
 * write edge, and deliberately *not* deep-cloned by hierarchy.ts's
 * flatten() (which structuredClone()s every other component every single
 * call) — a write has to survive into the *next* flatten() call, which is
 * a fresh JS object entirely, so the byte array itself, not the component
 * wrapping it, is this component's actual persistent identity. See
 * flatten()'s own doc comment for the reference-preservation this needs.
 */
export interface RamComponent {
  id: string;
  kind: 'ram';
  addrBits: number;
  dataBits: number;
  bytes: Uint8Array; // length === 2 ** addrBits; index i holds the byte at address i
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pinOrder: string[];
  pins: Record<string, Pin>;
}

/**
 * Behavioral read-only memory — same OE-gated read as RAM, no WE/CLK.
 * `bytes` is mutable from the MemoryEditor (load/fill) but never from the
 * solver. Same flatten aliasing rule as RamComponent.
 */
export interface RomComponent {
  id: string;
  kind: 'rom';
  addrBits: number;
  dataBits: number;
  bytes: Uint8Array;
  pos: Point;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  pinOrder: string[];
  pins: Record<string, Pin>;
}

/** RAM or ROM — shared by MemoryEditor / pin helpers. */
export type MemoryComponent = RamComponent | RomComponent;

export type Component =
  | TransistorComponent
  | SourceComponent
  | InputComponent
  | ButtonComponent
  | LedComponent
  | ClockComponent
  | AnalyzerComponent
  | TtyComponent
  | ProbeComponent
  | LabelComponent
  | PortComponent
  | ChipInstanceComponent
  | RamComponent
  | RomComponent;

/**
 * A wire directly connects two pins. `waypoints` (if present) are purely
 * cosmetic bend points the wire is drawn passing through, in order from
 * `a` to `b` — they exist only for Renderer.ts and don't change the
 * electrical net at all: Circuit.computeNets() and solver.ts never look
 * at them, only at `a`/`b`.
 */
export interface Wire {
  id: string;
  a: string; // pin id
  b: string; // pin id
  waypoints?: Point[];
}

/** Result of net resolution: every pin id maps to the net id it belongs to. */
export interface NetMap {
  netOf: Map<string, string>; // pinId -> netId
  pinsOf: Map<string, string[]>; // netId -> pinId[]
}

/** Simulation state: resolved level per net id, plus contention flags. */
export interface SimState {
  levelOf: Map<string, Level>;
  contended: Set<string>; // net ids where VCC and GND both drive — a short
  settled: boolean; // false if the relaxation loop hit the iteration cap
  iterations: number;
}
