import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/sim/Circuit.js';
import { circuitNeedsLabTick, tickLabInstruments } from '../src/sim/labTick.js';
import { makeAnalyzer, makeButton, makeClock, makeLed, makeRom, makeSource, wire } from '../src/sim/library.js';
import { applyBytes, formatHexDump, parseHexBlob } from '../src/ui/MemoryEditor.js';
import { deserializeProject, serializeProject } from '../src/sim/serialize.js';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { initialState, step } from '../src/sim/solver.js';
import { buildNot } from '../src/sim/library.js';

describe('lab instruments', () => {
  it('needsLabTick follows running clocks, held buttons, armed analyzers', () => {
    const c = new Circuit();
    expect(circuitNeedsLabTick(c)).toBe(false);
    const clk = makeClock(c);
    expect(circuitNeedsLabTick(c)).toBe(false);
    clk.running = true;
    expect(circuitNeedsLabTick(c)).toBe(true);
    clk.running = false;
    const btn = makeButton(c, { x: 0, y: 0 }, 'momentary');
    btn.holdFrames = 2;
    expect(circuitNeedsLabTick(c)).toBe(true);
    btn.holdFrames = 0;
    expect(circuitNeedsLabTick(c, true)).toBe(true);
  });

  it('orthogonal crossings detect H×V junctions', async () => {
    const { findWireCrossings } = await import('../src/ui/geometry.js');
    const crosses = findWireCrossings([
      [
        { x: 0, y: 10 },
        { x: 20, y: 10 },
      ],
      [
        { x: 10, y: 0 },
        { x: 10, y: 20 },
      ],
    ]);
    expect(crosses).toEqual([{ x: 10, y: 10 }]);
  });

  it('scripted momentary holdFrames decay then release', () => {
    const c = new Circuit();
    const btn = makeButton(c, { x: 0, y: 0 }, 'momentary');
    btn.pulseFrames = 3;
    btn.value = 1;
    btn.holdFrames = 3;
    expect(tickLabInstruments(c)).toBe(false);
    expect(btn.holdFrames).toBe(2);
    tickLabInstruments(c);
    tickLabInstruments(c);
    expect(btn.value).toBe(0);
    expect(btn.holdFrames).toBe(0);
  });

  it('momentary button stays high while mouse is held', async () => {
    const { Editor } = await import('../src/ui/Editor.js');
    const lib = new ChipLibrary();
    const c = new Circuit();
    const ed = new Editor(c, lib);
    const btn = makeButton(c, { x: 0, y: 0 }, 'momentary');
    ed.handleMouseDown({ x: 0, y: 0 });
    expect(btn.value).toBe(1);
    ed.handleMouseDrag({ x: 1, y: 0 }); // under drag threshold
    expect(btn.value).toBe(1);
    ed.handleMouseUp({ x: 1, y: 0 }, false);
    expect(btn.value).toBe(0);
  });

  it('momentary button releases when drag-moved', async () => {
    const { Editor } = await import('../src/ui/Editor.js');
    const lib = new ChipLibrary();
    const c = new Circuit();
    const ed = new Editor(c, lib);
    const btn = makeButton(c, { x: 0, y: 0 }, 'momentary');
    ed.handleMouseDown({ x: 0, y: 0 });
    expect(btn.value).toBe(1);
    ed.handleMouseDrag({ x: 40, y: 0 });
    expect(btn.value).toBe(0);
    ed.handleMouseUp({ x: 40, y: 0 }, false);
    expect(btn.value).toBe(0);
  });

  it('clock toggles when running', () => {
    const c = new Circuit();
    const clk = makeClock(c, { x: 0, y: 0 }, 4);
    clk.running = true;
    clk.dutyFrames = 2;
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      tickLabInstruments(c);
      seen.push(clk.value);
    }
    expect(seen).toEqual([1, 1, 0, 0]);
  });

  it('oneshot pulse fires for dutyFrames then clears', () => {
    const c = new Circuit();
    const clk = makeClock(c, { x: 0, y: 0 }, 10, 'oneshot');
    clk.dutyFrames = 3;
    clk.holdFrames = 3;
    clk.value = 1;
    tickLabInstruments(c);
    tickLabInstruments(c);
    expect(clk.value).toBe(1);
    tickLabInstruments(c);
    expect(clk.value).toBe(0);
  });

  it('analyzer has N channel pins', () => {
    const c = new Circuit();
    const la = makeAnalyzer(c, 5, { x: 0, y: 0 });
    expect(la.channelCount).toBe(5);
    expect(Object.keys(la.pins)).toEqual(['ch0', 'ch1', 'ch2', 'ch3', 'ch4']);
  });

  it('ROM drives data when OE=1', () => {
    const c = new Circuit();
    makeSource(c, 1, { x: 0, y: 0 });
    makeSource(c, 0, { x: 0, y: 40 });
    const rom = makeRom(c, 2, 8, Uint8Array.from([0x5a, 0x00, 0x00, 0x00]), { x: 100, y: 0 });
    wire(c, makeSource(c, 1, { x: 40, y: 80 }).pins.out, rom.pins.oe!);
    // addr = 0 (floating addr bits vote/history — force GND on all addr)
    for (let i = 0; i < 2; i++) {
      wire(c, makeSource(c, 0, { x: 20, y: 120 + i * 20 }).pins.out, rom.pins[`addr${i}`]!);
    }
    const nets = c.computeNets();
    let state = initialState();
    for (let i = 0; i < 8; i++) state = step(c, nets, state);
    const d0 = nets.netOf.get(rom.pins.data0!.id)!;
    const d1 = nets.netOf.get(rom.pins.data1!.id)!;
    const d3 = nets.netOf.get(rom.pins.data3!.id)!;
    const d4 = nets.netOf.get(rom.pins.data4!.id)!;
    const d6 = nets.netOf.get(rom.pins.data6!.id)!;
    // 0x5A = 01011010
    expect(state.levelOf.get(d0)).toBe(0);
    expect(state.levelOf.get(d1)).toBe(1);
    expect(state.levelOf.get(d3)).toBe(1);
    expect(state.levelOf.get(d4)).toBe(1);
    expect(state.levelOf.get(d6)).toBe(1);
  });

  it('Button → NOT → LED path settles', () => {
    const c = new Circuit();
    makeSource(c, 1, { x: 0, y: 0 });
    makeSource(c, 0, { x: 0, y: 40 });
    const btn = makeButton(c, { x: 40, y: 80 }, 'toggle');
    btn.value = 1;
    const inv = buildNot(c, { x: 120, y: 80 });
    wire(c, btn.pins.out, inv.in);
    const led = makeLed(c, { x: 220, y: 80 });
    wire(c, inv.out, led.pins.in);
    const nets = c.computeNets();
    let state = initialState();
    for (let i = 0; i < 8; i++) state = step(c, nets, state);
    const net = nets.netOf.get(led.pins.in.id)!;
    expect(state.levelOf.get(net)).toBe(0);
  });
});

describe('memory editor helpers', () => {
  it('parses and applies hex', () => {
    expect(parseHexBlob('de ad be ef')).toEqual([0xde, 0xad, 0xbe, 0xef]);
    const c = new Circuit();
    const rom = makeRom(c, 3, 8);
    expect(applyBytes(rom, 1, [0xaa, 0xbb])).toBe(2);
    expect(rom.bytes[1]).toBe(0xaa);
    expect(rom.bytes[2]).toBe(0xbb);
    expect(formatHexDump(Uint8Array.from([0x41, 0x00])).includes('41')).toBe(true);
  });
});

describe('serialize lab kinds', () => {
  it('round-trips button, clock, led, rom', () => {
    const lib = new ChipLibrary();
    const c = new Circuit();
    makeButton(c, { x: 0, y: 0 }, 'toggle');
    makeClock(c, { x: 40, y: 0 }, 10);
    makeLed(c, { x: 80, y: 0 }, 'Q');
    makeRom(c, 4, 8, Uint8Array.from([1, 2, 3]));
    const json = serializeProject(c, lib);
    const loaded = deserializeProject(json);
    const kinds = [...loaded.topCircuit.components.values()].map((x) => x.kind).sort();
    expect(kinds).toContain('button');
    expect(kinds).toContain('clock');
    expect(kinds).toContain('led');
    expect(kinds).toContain('rom');
    const rom = [...loaded.topCircuit.components.values()].find((x) => x.kind === 'rom')!;
    expect(rom.bytes[0]).toBe(1);
    expect(rom.bytes[2]).toBe(3);
  });
});
