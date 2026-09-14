import { describe, expect, it } from 'vitest';
import { KEY_DATA, KEY_STATUS, MACHINE_ADDR_BITS } from '../src/machine/memoryMap.js';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { flatten } from '../src/sim/hierarchy.js';
import { makeInput, makeRam, ramAddrPins, ramDataPins, wire } from '../src/sim/library.js';
import { clearKeyStatusOnDataRead, initialState, step } from '../src/sim/solver.js';
import type { Level, NetMap, SimState } from '../src/sim/types.js';
import { injectKey } from '../src/machine/tty.js';

/**
 * Re-flattens fresh every single sub-tick, exactly like main.ts's live
 * render loop does every animation frame — this is the harness that
 * actually exercises the "does a write survive the next flatten() call"
 * concern, not just "does the read/write logic work once." A `tick` that
 * reused the same flattened Circuit across calls (like sequential.test.ts's
 * own `tick` helper) would never have caught a reference-cloning bug here.
 */
function tickFlatten(top: Circuit, library: ChipLibrary, state: SimState, n = 10): { state: SimState; netMap: NetMap } {
  let netMap!: NetMap;
  for (let i = 0; i < n; i++) {
    const flat = flatten(top, library);
    netMap = flat.computeNets();
    state = step(flat, netMap, state);
  }
  return { state, netMap };
}

function levelAt(state: SimState, netMap: NetMap, pinId: string): Level {
  const net = netMap.netOf.get(pinId);
  if (!net) throw new Error(`unknown pin ${pinId}`);
  return state.levelOf.get(net) ?? 'Z';
}

function toBits(n: number, width: number): (0 | 1)[] {
  return Array.from({ length: width }, (_, i) => ((n >> i) & 1) as 0 | 1);
}
function fromBits(bits: Level[]): number {
  return bits.reduce<number>((acc, b, i) => acc + (b === 1 ? 1 << i : 0), 0);
}

describe('RAM — behavioral read/write memory', () => {
  /**
   * `wireData` controls whether the data bus gets its own always-on
   * `Input`s. Read-focused tests must leave it `false`: an `Input` (even
   * one sitting at 0) is an *unconditional* driver, and wiring one to every
   * data pin regardless of `oe` would fight RAM's own conditional
   * read-drive (or, with oe=0, would make the bus read a confidently wrong
   * 0 instead of genuinely floating) — the exact same "don't wire a driver
   * onto a pin that's supposed to be a bare sink" lesson `buildDecoder`'s
   * own bug (see ARCHITECTURE.md's "Buses") already established. Only
   * write-focused tests, which need something to actually put data *onto*
   * the bus, ask for `wireData: true`.
   */
  function setup(addrBits: number, dataBits = 8, initial?: Uint8Array, wireData = false) {
    const library = new ChipLibrary();
    const parent = new Circuit();
    const ram = makeRam(parent, addrBits, dataBits, initial);

    const addrIns = ramAddrPins(ram).map((p) => {
      const input = makeInput(parent, 0);
      wire(parent, input.pins.out, p);
      return input;
    });
    const dataIns = wireData
      ? ramDataPins(ram).map((p) => {
          const input = makeInput(parent, 0);
          wire(parent, input.pins.out, p);
          return input;
        })
      : [];
    const we = makeInput(parent, 0);
    const oe = makeInput(parent, 0);
    const clk = makeInput(parent, 0);
    wire(parent, we.pins.out, ram.pins.we!);
    wire(parent, oe.pins.out, ram.pins.oe!);
    wire(parent, clk.pins.out, ram.pins.clk!);

    return { library, parent, ram, addrIns, dataIns, we, oe, clk };
  }

  it('reads bytes[addr] onto the data pins while oe=1', () => {
    const initial = Uint8Array.of(0x4d, 0x00, 0xff, 0x0f);
    const { library, parent, ram, addrIns, oe } = setup(2, 8, initial);
    const readData = () => fromBits(ramDataPins(ram).map((p) => levelAt(state, netMap, p.id)));
    const setAddr = (n: number) => toBits(n, 2).forEach((v, i) => (addrIns[i]!.value = v));

    let state = initialState();
    let netMap!: NetMap;
    oe.value = 1;
    for (let addr = 0; addr < initial.length; addr++) {
      setAddr(addr);
      ({ state, netMap } = tickFlatten(parent, library, state));
      expect(readData()).toBe(initial[addr]);
    }
  });

  it('floats (no forced driver) on every data pin while oe=0', () => {
    const { library, parent, ram, addrIns } = setup(2, 8, Uint8Array.of(0xff));
    addrIns[0]!.value = 0;
    addrIns[1]!.value = 0;
    let state = initialState();
    let netMap!: NetMap;
    ({ state, netMap } = tickFlatten(parent, library, state));
    for (const p of ramDataPins(ram)) expect(levelAt(state, netMap, p.id)).toBe('Z');
  });

  it("we=1 suppresses RAM's own read-drive, so an external driver on the bus isn't fought", () => {
    const { library, parent, ram, addrIns, dataIns, we, oe } = setup(1, 4, Uint8Array.of(0b1010), true);
    addrIns[0]!.value = 0;
    oe.value = 1;
    we.value = 1; // write mode: RAM must not also drive the bus with bytes[0]=0b1010
    dataIns.forEach((d, i) => (d.value = ((0b0101 >> i) & 1) as 0 | 1)); // external driver says 0b0101

    let state = initialState();
    let netMap!: NetMap;
    ({ state, netMap } = tickFlatten(parent, library, state));
    expect(fromBits(ramDataPins(ram).map((p) => levelAt(state, netMap, p.id)))).toBe(0b0101);
    expect(state.contended.size).toBe(0); // no fight: RAM genuinely isn't driving
  });

  it('captures the data bus into bytes[addr] on a we&clk rising edge, and the write survives later flatten() calls', () => {
    const { library, parent, ram, addrIns, dataIns, we, clk, oe } = setup(2, 8, undefined, true);
    const setAddr = (n: number) => toBits(n, 2).forEach((v, i) => (addrIns[i]!.value = v));
    const setData = (n: number) => toBits(n, 8).forEach((v, i) => (dataIns[i]!.value = v));

    let state = initialState();
    let netMap!: NetMap;
    ({ state, netMap } = tickFlatten(parent, library, state)); // settle with everything at 0

    setAddr(2);
    setData(0x4d);
    we.value = 1;
    clk.value = 1; // rising edge: writes 0x4d into address 2
    ({ state, netMap } = tickFlatten(parent, library, state));
    expect(ram.bytes[2]).toBe(0x4d);

    // Change the bus and hold clk high (no new 0->1 transition): must NOT re-write.
    clk.value = 1;
    setData(0xff);
    ({ state, netMap } = tickFlatten(parent, library, state));
    expect(ram.bytes[2]).toBe(0x4d);

    // Drop we/clk, select a *different* address (forcing several more
    // flatten() calls in between), then come back to address 2 and read —
    // this is the actual persistence check, not just "the array has the
    // right value in-process."
    clk.value = 0;
    we.value = 0;
    setAddr(0);
    ({ state, netMap } = tickFlatten(parent, library, state));
    setAddr(2);
    oe.value = 1;
    ({ state, netMap } = tickFlatten(parent, library, state));
    expect(fromBits(ramDataPins(ram).map((p) => levelAt(state, netMap, p.id)))).toBe(0x4d);
  });

  it('a genuinely floating (unwired) data bit writes as 0, not garbage or a thrown error', () => {
    const library = new ChipLibrary();
    const parent = new Circuit();
    const ram = makeRam(parent, 1, 4);
    const addr0 = makeInput(parent, 0);
    wire(parent, addr0.pins.out, ramAddrPins(ram)[0]!);
    // Only wire data bits 0 and 1 — bits 2 and 3 are left completely
    // unwired, a genuinely floating net each, not merely "driven to 0".
    const d0 = makeInput(parent, 1);
    const d1 = makeInput(parent, 1);
    wire(parent, d0.pins.out, ramDataPins(ram)[0]!);
    wire(parent, d1.pins.out, ramDataPins(ram)[1]!);
    const we = makeInput(parent, 1);
    const clk = makeInput(parent, 0);
    wire(parent, we.pins.out, ram.pins.we!);
    wire(parent, clk.pins.out, ram.pins.clk!);

    let state = initialState();
    let netMap!: NetMap;
    ({ state, netMap } = tickFlatten(parent, library, state));
    clk.value = 1;
    ({ state, netMap } = tickFlatten(parent, library, state));
    expect(ram.bytes[0]).toBe(0b0011); // bits 2,3 unresolved -> committed as 0, not skipped or thrown
  });
});

describe('clearKeyStatusOnDataRead helper', () => {
  it('clears KEY_STATUS only when addr is KEY_DATA', () => {
    const bytes = new Uint8Array(1 << MACHINE_ADDR_BITS);
    injectKey(bytes, 0x41);
    clearKeyStatusOnDataRead(bytes, KEY_STATUS);
    expect(bytes[KEY_STATUS]).toBe(1);
    clearKeyStatusOnDataRead(bytes, KEY_DATA);
    expect(bytes[KEY_STATUS]).toBe(0);
    expect(bytes[KEY_DATA]).toBe(0x41);
  });

  it('clears KEY_STATUS when gate RAM OE reads KEY_DATA', () => {
    const library = new ChipLibrary();
    const parent = new Circuit();
    const ram = makeRam(parent, MACHINE_ADDR_BITS, 8);
    injectKey(ram.bytes, 0x21);

    const addrIns = ramAddrPins(ram).map((p) => {
      const input = makeInput(parent, 0);
      wire(parent, input.pins.out, p);
      return input;
    });
    const we = makeInput(parent, 0);
    const oe = makeInput(parent, 0);
    const clk = makeInput(parent, 0);
    wire(parent, we.pins.out, ram.pins.we!);
    wire(parent, oe.pins.out, ram.pins.oe!);
    wire(parent, clk.pins.out, ram.pins.clk!);

    const setAddr = (n: number) => {
      for (let i = 0; i < MACHINE_ADDR_BITS; i++) {
        addrIns[i]!.value = ((n >> i) & 1) as 0 | 1;
      }
    };

    let state = initialState();
    oe.value = 1;
    setAddr(KEY_STATUS);
    for (let i = 0; i < 4; i++) {
      const flat = flatten(parent, library);
      const netMap = flat.computeNets();
      state = step(flat, netMap, state);
    }
    expect(ram.bytes[KEY_STATUS]).toBe(1); // reading status does not clear

    setAddr(KEY_DATA);
    for (let i = 0; i < 4; i++) {
      const flat = flatten(parent, library);
      const netMap = flat.computeNets();
      state = step(flat, netMap, state);
    }
    expect(ram.bytes[KEY_STATUS]).toBe(0);
    expect(ram.bytes[KEY_DATA]).toBe(0x21);
  });
});
