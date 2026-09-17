import { describe, expect, it } from 'vitest';
import { createSoftZ80, softStep } from '../src/machine/softZ80.js';
import { Circuit } from '../src/sim/Circuit.js';
import { makeTransistor } from '../src/sim/library.js';
import { EditHistory } from '../src/ui/EditHistory.js';
import { Editor } from '../src/ui/Editor.js';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';

describe('soft EI delay', () => {
  it('enables IFF only after the following instruction', () => {
    const cpu = createSoftZ80();
    const ram = new Uint8Array(256);
    // EI ; NOP ; …
    ram[0] = 0xfb;
    ram[1] = 0x00;
    softStep(cpu, ram);
    expect(cpu.iff1).toBe(false);
    expect(cpu.eiDelay).toBe(1);
    softStep(cpu, ram);
    expect(cpu.iff1).toBe(true);
    expect(cpu.eiDelay).toBe(0);
  });
});

describe('edit history + clipboard', () => {
  it('undo restores deleted component', () => {
    const lib = new ChipLibrary();
    const c = new Circuit();
    const hist = new EditHistory();
    const ed = new Editor(c, lib);
    ed.onBeforeEdit = () => hist.checkpoint(ed.circuit);
    makeTransistor(c, 'N', { x: 0, y: 0 });
    const id = [...c.components.keys()][0]!;
    ed.selectedIds = new Set([id]);
    ed.handleDelete();
    expect(c.components.size).toBe(0);
    expect(hist.undo(c)).toBe(true);
    expect(c.components.size).toBe(1);
  });

  it('copy/paste duplicates selection', () => {
    const lib = new ChipLibrary();
    const c = new Circuit();
    const ed = new Editor(c, lib);
    makeTransistor(c, 'N', { x: 0, y: 0 });
    const id = [...c.components.keys()][0]!;
    ed.selectedIds = new Set([id]);
    expect(ed.copySelection()).toBe(true);
    expect(ed.pasteClipboard()).toBe(true);
    expect(c.components.size).toBe(2);
  });

  it('skips pasting chips whose defId was wiped from the library', () => {
    const lib = new ChipLibrary();
    const c = new Circuit();
    const ed = new Editor(c, lib);
    // Simulate clipboard captured before a Lab-course project reload.
    (ed as unknown as { clipboard: { components: unknown[]; wires: unknown[] } }).clipboard = {
      components: [
        {
          id: 'chip1',
          kind: 'chip',
          defId: 'chipdef1702629',
          defRevision: 0,
          pos: { x: 0, y: 0 },
          rotation: 0,
          mirrorX: false,
          mirrorY: false,
          pinOrder: [],
          pins: {},
        },
        {
          id: 't1',
          kind: 'transistor',
          type: 'N',
          pos: { x: 20, y: 0 },
          rotation: 0,
          mirrorX: false,
          mirrorY: false,
          pins: {
            gate: { id: 't1:gate', componentId: 't1', name: 'gate', pos: { x: 0, y: 0 } },
            drain: { id: 't1:drain', componentId: 't1', name: 'drain', pos: { x: 0, y: 0 } },
            source: { id: 't1:source', componentId: 't1', name: 'source', pos: { x: 0, y: 0 } },
          },
        },
      ],
      wires: [],
    };
    expect(ed.pasteClipboard()).toBe(true);
    expect([...c.components.values()].some((x) => x.kind === 'chip')).toBe(false);
    expect([...c.components.values()].some((x) => x.kind === 'transistor')).toBe(true);
  });

  it('clears sticky net tip after deleting a selected wire', () => {
    const lib = new ChipLibrary();
    const c = new Circuit();
    const ed = new Editor(c, lib);
    const a = makeTransistor(c, 'N', { x: 0, y: 0 });
    const b = makeTransistor(c, 'N', { x: 80, y: 0 });
    const w = c.addWire(a.pins.drain.id, b.pins.drain.id);
    ed.selectedWireId = w.id;
    ed.highlightNetOfWire(w.id);
    ed.hoveredWireId = w.id;
    expect(ed.highlightedNetId).toBeTruthy();

    ed.handleDelete();

    expect(c.wires.size).toBe(0);
    expect(ed.highlightedNetId).toBeNull();
    expect(ed.hoveredWireId).toBeNull();
    expect(ed.formatNetName(ed.netIdUnderPointer())).toBeNull();
  });
});
