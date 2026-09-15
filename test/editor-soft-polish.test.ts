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
});
