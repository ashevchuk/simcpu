/**
 * Object inspector — configure the selected component (labels, button mode,
 * pulse timing, orientation, …) without modal prompts. Multi-select shows
 * bulk rotate/mirror when every selected part is orientable.
 */

import type { Circuit } from '../sim/Circuit.js';
import type { ChipLibrary } from '../sim/ChipLibrary.js';
import { renamePort } from '../sim/hierarchy.js';
import {
  applyPinLayout,
  getOrientation,
  isOrientable,
  orientSelection,
  relayoutDefInstances,
} from '../sim/orientation.js';
import { CHIP_INSTANCE_WIDTH } from '../sim/library.js';
import type { ChipInstanceComponent, Component } from '../sim/types.js';
import type { Editor } from './Editor.js';
import { FloatingWindow } from './FloatingWindow.js';

export class ObjectInspector {
  private readonly win = new FloatingWindow('Inspector');
  private target: Component | null = null;
  private targets: Component[] = [];
  private lastSyncedKey: string | null = null;
  private circuit: Circuit | null = null;
  private library: ChipLibrary | null = null;
  /** ChipDef id when editing inside a folded chip (for port rename). */
  private defId: string | null = null;
  private allCircuits: Circuit[] = [];
  onChange: (() => void) | null = null;
  onBeforeEdit: (() => void) | null = null;
  /** Dive into a chip instance from the inspector. */
  onDive: ((inst: ChipInstanceComponent) => void) | null = null;
  /** Add pin id(s) to the watch list (no circuit edit). */
  onWatchPins: ((pinIds: string[]) => void) | null = null;
  /** Refresh pinSide/layout/revision from the shared ChipDef. */
  onUpdateFromLibrary: ((inst: ChipInstanceComponent) => void) | null = null;
  /** Editor for align/distribute (multi-select). */
  editor: Editor | null = null;

  constructor() {
    this.win.setTitle('Inspector', '');
    this.win.setVisible(false);
  }

  setContext(opts: {
    circuit: Circuit;
    library: ChipLibrary;
    defId: string | null;
    allCircuits: Circuit[];
  }): void {
    this.circuit = opts.circuit;
    this.library = opts.library;
    this.defId = opts.defId;
    this.allCircuits = opts.allCircuits;
  }

  /**
   * Show inspector for one component, a multi-selection, or hide when empty.
   */
  sync(selected: Component | Component[] | null, force = false): void {
    const list = selected == null ? [] : Array.isArray(selected) ? selected : [selected];
    const key = list.map((c) => c.id).sort().join(',') || null;
    if (!force && key === this.lastSyncedKey) {
      this.targets = list;
      this.target = list.length === 1 ? list[0]! : null;
      if (list.length === 0) this.win.setVisible(false);
      return;
    }
    this.lastSyncedKey = key;
    this.targets = list;
    this.target = list.length === 1 ? list[0]! : null;
    if (list.length === 0) {
      this.win.setVisible(false);
      return;
    }
    if (list.length === 1) {
      this.win.setTitle('Inspector', list[0]!.kind);
      this.render();
    } else {
      this.win.setTitle('Inspector', `${list.length} selected`);
      this.renderMulti();
    }
    this.win.setVisible(true);
  }

  /** Rebuild form for the current target (after rotate from keyboard, etc.). */
  refresh(): void {
    if (this.targets.length > 1) this.renderMulti();
    else if (this.target) this.render();
  }

  private noteEdit(): void {
    this.onBeforeEdit?.();
  }

  private changed(): void {
    this.onChange?.();
    if (this.targets.length > 1) this.renderMulti();
    else this.render();
  }

  private orientTargets(mode: 'cw' | 'ccw' | 'flipH' | 'flipV'): void {
    const comps = this.targets.filter(isOrientable);
    const circuit = this.circuit;
    if (!circuit || comps.length === 0) return;
    orientSelection(comps, mode, (c, dx, dy) => circuit.moveComponent(c.id, dx, dy));
    this.editor?.tidySelectedWires(false);
  }

  private mkBtn(label: string, title: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.style.cssText =
      'background:#20242f;border:1px solid #333a48;border-radius:6px;color:#e7e9ef;padding:5px 10px;font:12px ui-monospace,monospace;cursor:pointer';
    b.addEventListener('click', () => {
      this.noteEdit();
      fn();
      this.changed();
    });
    return b;
  }

  private renderMulti(): void {
    const body = this.win.body;
    body.replaceChildren();
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.gap = '8px';

    const orientable = this.targets.filter(isOrientable);
    const summary = document.createElement('div');
    summary.style.cssText = 'font:12px ui-monospace,monospace;color:#9aa1b3';
    summary.textContent = `${this.targets.length} parts · ${orientable.length} rotatable`;
    body.appendChild(summary);

    if (this.targets.length >= 2 && this.editor) {
      const ed = this.editor;
      const alignRow = document.createElement('div');
      alignRow.style.display = 'flex';
      alignRow.style.flexWrap = 'wrap';
      alignRow.style.gap = '6px';
      alignRow.append(
        this.mkBtn('←', 'Align left (Alt+←)', () => ed.alignSelection('x', 'min')),
        this.mkBtn('→', 'Align right (Alt+→)', () => ed.alignSelection('x', 'max')),
        this.mkBtn('↑', 'Align top (Alt+↑)', () => ed.alignSelection('y', 'min')),
        this.mkBtn('↓', 'Align bottom (Alt+↓)', () => ed.alignSelection('y', 'max')),
        this.mkBtn('↔ mid', 'Align centers X', () => ed.alignSelection('x', 'mid')),
        this.mkBtn('↕ mid', 'Align centers Y', () => ed.alignSelection('y', 'mid')),
      );
      body.appendChild(alignRow);
      if (this.targets.length >= 3) {
        const distRow = document.createElement('div');
        distRow.style.display = 'flex';
        distRow.style.flexWrap = 'wrap';
        distRow.style.gap = '6px';
        distRow.append(
          this.mkBtn('Distribute H', 'Even spacing horizontally (Alt+Shift+←/→)', () =>
            ed.distributeSelection('x'),
          ),
          this.mkBtn('Distribute V', 'Even spacing vertically (Alt+Shift+↑/↓)', () =>
            ed.distributeSelection('y'),
          ),
        );
        body.appendChild(distRow);
      }
    }

    if (orientable.length === 0) return;

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.flexWrap = 'wrap';
    row.style.gap = '6px';
    row.append(
      this.mkBtn('↻ 90°', 'Rotate all clockwise (R)', () => this.orientTargets('cw')),
      this.mkBtn('↺ 90°', 'Rotate all counter-clockwise (Shift+R)', () => this.orientTargets('ccw')),
      this.mkBtn('Flip H', 'Flip all horizontally (M)', () => this.orientTargets('flipH')),
      this.mkBtn('Flip V', 'Flip all vertically (Shift+M)', () => this.orientTargets('flipV')),
    );
    const hint = document.createElement('div');
    hint.style.cssText = 'font:11px ui-monospace,monospace;color:#9aa1b3';
    hint.textContent = 'bulk orient · R / Shift+R / M / Shift+M · Alt+arrows align';
    body.append(row, hint);
  }

  private render(): void {
    const c = this.target;
    if (!c) return;
    const body = this.win.body;
    body.replaceChildren();
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.gap = '8px';

    const addRow = (label: string, el: HTMLElement) => {
      const row = document.createElement('label');
      row.style.display = 'grid';
      row.style.gridTemplateColumns = '88px 1fr';
      row.style.alignItems = 'center';
      row.style.gap = '8px';
      row.style.fontSize = '12px';
      row.style.color = '#9aa1b3';
      const lab = document.createElement('span');
      lab.textContent = label;
      row.append(lab, el);
      body.appendChild(row);
    };

    const textInput = (value: string, onCommit: (v: string) => void) => {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value;
      input.style.cssText =
        'width:100%;box-sizing:border-box;background:#12141a;border:1px solid #303646;border-radius:6px;color:#e7e9ef;padding:5px 8px;font:12px ui-monospace,monospace';
      input.addEventListener('change', () => onCommit(input.value));
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          input.blur();
        }
      });
      return input;
    };

    const numInput = (value: number, onCommit: (v: number) => void, min?: number, max?: number) => {
      const input = document.createElement('input');
      input.type = 'number';
      input.value = String(value);
      if (min != null) input.min = String(min);
      if (max != null) input.max = String(max);
      input.style.cssText =
        'width:100%;box-sizing:border-box;background:#12141a;border:1px solid #303646;border-radius:6px;color:#e7e9ef;padding:5px 8px;font:12px ui-monospace,monospace';
      input.addEventListener('change', () => {
        const n = parseInt(input.value, 10);
        if (!Number.isFinite(n)) return;
        onCommit(n);
      });
      return input;
    };

    const select = (value: string, options: { value: string; label: string }[], onCommit: (v: string) => void) => {
      const el = document.createElement('select');
      el.style.cssText =
        'width:100%;box-sizing:border-box;background:#12141a;border:1px solid #303646;border-radius:6px;color:#e7e9ef;padding:5px 8px;font:12px ui-monospace,monospace';
      for (const o of options) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        if (o.value === value) opt.selected = true;
        el.appendChild(opt);
      }
      el.addEventListener('change', () => onCommit(el.value));
      return el;
    };

    addRow('id', (() => {
      const span = document.createElement('span');
      span.style.fontFamily = 'ui-monospace, monospace';
      span.style.color = '#e7e9ef';
      span.textContent = c.id;
      return span;
    })());

    if (c.kind === 'label') {
      addRow(
        'net',
        textInput(c.name, (v) => {
          const name = v.trim();
          if (!name || name === c.name) return;
          this.noteEdit();
          c.name = name;
          this.changed();
        }),
      );
    }

    if (c.kind === 'port') {
      addRow(
        'name',
        textInput(c.name, (v) => {
          const name = v.trim();
          if (!name || name === c.name) return;
          this.noteEdit();
          if (this.library && this.defId) {
            const ok = renamePort(this.library, this.allCircuits, this.defId, c.name, name);
            if (!ok) {
              this.render();
              return;
            }
          } else {
            const circuit = this.editor?.circuit;
            if (circuit) {
              for (const other of circuit.components.values()) {
                if (other.kind === 'port' && other.id !== c.id && other.name === name) {
                  this.render();
                  return;
                }
              }
            }
            c.name = name;
          }
          this.changed();
        }),
      );
      addRow(
        'dir',
        select(
          c.dir ?? 'inout',
          [
            { value: 'in', label: 'in' },
            { value: 'out', label: 'out' },
            { value: 'inout', label: 'inout' },
          ],
          (v) => {
            this.noteEdit();
            c.dir = v === 'in' || v === 'out' ? v : 'inout';
            if (this.library && this.defId) {
              const def = this.library.get(this.defId);
              relayoutDefInstances(def, this.allCircuits);
            }
            this.changed();
          },
        ),
      );
    }

    if (c.kind === 'button') {
      addRow(
        'mode',
        select(
          c.mode,
          [
            { value: 'momentary', label: 'momentary' },
            { value: 'toggle', label: 'toggle' },
          ],
          (v) => {
            this.noteEdit();
            c.mode = v === 'toggle' ? 'toggle' : 'momentary';
            c.holdFrames = 0;
            c.value = 0;
            this.changed();
          },
        ),
      );
      addRow(
        'pulse fr',
        numInput(
          c.pulseFrames,
          (n) => {
            this.noteEdit();
            c.pulseFrames = Math.max(1, n);
            this.changed();
          },
          1,
          600,
        ),
      );
    }

    if (c.kind === 'clock') {
      addRow(
        'mode',
        select(
          c.mode,
          [
            { value: 'continuous', label: 'continuous' },
            { value: 'oneshot', label: 'oneshot' },
          ],
          (v) => {
            this.noteEdit();
            c.mode = v === 'oneshot' ? 'oneshot' : 'continuous';
            c.running = false;
            c.holdFrames = 0;
            c.phase = 0;
            c.value = 0;
            this.changed();
          },
        ),
      );
      addRow(
        'period',
        numInput(
          c.periodFrames,
          (n) => {
            this.noteEdit();
            c.periodFrames = Math.max(2, n);
            c.dutyFrames = Math.max(1, Math.min(c.periodFrames - 1, c.dutyFrames));
            this.changed();
          },
          2,
          3600,
        ),
      );
      addRow(
        'duty',
        numInput(
          c.dutyFrames,
          (n) => {
            this.noteEdit();
            c.dutyFrames = Math.max(1, Math.min(c.periodFrames - 1, n));
            this.changed();
          },
          1,
          3599,
        ),
      );
    }

    if (c.kind === 'led') {
      addRow(
        'label',
        textInput(c.label ?? '', (v) => {
          this.noteEdit();
          if (v.trim()) c.label = v.trim();
          else delete c.label;
          this.changed();
        }),
      );
      addRow(
        'color',
        textInput(c.color, (v) => {
          if (!v.trim()) return;
          this.noteEdit();
          c.color = v.trim();
          this.changed();
        }),
      );
    }

    if (c.kind === 'sevenseg') {
      addRow(
        'color',
        textInput(c.color, (v) => {
          if (!v.trim()) return;
          this.noteEdit();
          c.color = v.trim();
          this.changed();
        }),
      );
    }

    if (c.kind === 'probe' || c.kind === 'busprobe') {
      addRow(
        'label',
        textInput(c.label ?? '', (v) => {
          this.noteEdit();
          if (v.trim()) c.label = v.trim();
          else delete c.label;
          this.changed();
        }),
      );
    }

    const pinIds = Object.values(c.pins).map((p) => p.id);
    if (pinIds.length > 0 && this.onWatchPins) {
      const watchBtn = document.createElement('button');
      watchBtn.type = 'button';
      watchBtn.textContent = pinIds.length === 1 ? 'Watch pin' : 'Watch pins';
      watchBtn.title = 'Add pin(s) to the Watch List (Ctrl+W)';
      watchBtn.style.cssText =
        'background:#20242f;border:1px solid #333a48;border-radius:6px;color:#e7e9ef;padding:5px 10px;font:12px ui-monospace,monospace;cursor:pointer';
      watchBtn.addEventListener('click', () => this.onWatchPins?.(pinIds));
      body.appendChild(watchBtn);
    }

    if (c.kind === 'input' || c.kind === 'source') {
      addRow(
        'value',
        select(
          String(c.value),
          [
            { value: '0', label: '0' },
            { value: '1', label: '1' },
          ],
          (v) => {
            this.noteEdit();
            c.value = v === '1' ? 1 : 0;
            this.changed();
          },
        ),
      );
    }

    if (c.kind === 'transistor') {
      addRow(
        'type',
        (() => {
          const span = document.createElement('span');
          span.style.color = '#e7e9ef';
          span.textContent = c.type === 'N' ? 'NMOS' : 'PMOS';
          return span;
        })(),
      );
    }

    if (c.kind === 'chip') {
      const defName = this.library?.has(c.defId) ? this.library.get(c.defId).name : c.defId;
      addRow(
        'def',
        (() => {
          const span = document.createElement('span');
          span.style.color = '#e7e9ef';
          span.style.fontFamily = 'ui-monospace, monospace';
          span.textContent = defName;
          return span;
        })(),
      );
      addRow(
        'marking',
        textInput(c.marking ?? '', (v) => {
          this.editor?.setChipAppearance(c.id, { marking: v });
          this.changed();
        }),
      );
      addRow(
        'width',
        numInput(c.boxWidth ?? CHIP_INSTANCE_WIDTH, (v) => {
          this.editor?.setChipAppearance(c.id, { boxWidth: v });
          this.changed();
        }, 48, 240),
      );
      this.appendPinOrderEditor(body, c);
      const defRev = this.library?.has(c.defId) ? (this.library.get(c.defId).revision ?? 0) : 0;
      const stale = defRev !== (c.defRevision ?? 0);
      if (stale) {
        body.appendChild(
          this.mkBtn('Update from library', 'Refresh pin sides / layout and clear edited badge', () => {
            this.onUpdateFromLibrary?.(c);
            this.changed();
          }),
        );
      }
      body.appendChild(
        this.mkBtn('Dive in', 'Open chip internals (same as dblclick)', () => {
          this.onDive?.(c);
        }),
      );
    }

    if (c.kind === 'ram' || c.kind === 'rom') {
      addRow(
        'size',
        (() => {
          const span = document.createElement('span');
          span.style.color = '#e7e9ef';
          span.textContent = `${1 << c.addrBits}×${c.dataBits}`;
          return span;
        })(),
      );
      this.appendPinOrderEditor(body, c);
    }

    if (isOrientable(c)) {
      const { rotation, mirrorX, mirrorY } = getOrientation(c);
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.flexWrap = 'wrap';
      row.style.gap = '6px';
      row.style.marginTop = '4px';

      row.append(
        this.mkBtn('↻ 90°', 'Rotate clockwise (R)', () => this.orientTargets('cw')),
        this.mkBtn('↺ 90°', 'Rotate counter-clockwise (Shift+R)', () => this.orientTargets('ccw')),
        this.mkBtn(mirrorX ? 'Flip H ✓' : 'Flip H', 'Flip horizontally (M)', () => this.orientTargets('flipH')),
        this.mkBtn(mirrorY ? 'Flip V ✓' : 'Flip V', 'Flip vertically (Shift+M)', () => this.orientTargets('flipV')),
      );
      const hint = document.createElement('div');
      hint.style.cssText = 'font:11px ui-monospace,monospace;color:#9aa1b3;margin-top:2px';
      const flips = [mirrorX ? 'H' : '', mirrorY ? 'V' : ''].filter(Boolean).join('+');
      hint.textContent = `orient ${rotation}°${flips ? ` · flip ${flips}` : ''} · R / Shift+R / M / Shift+M`;
      body.append(row, hint);
    }

    if (c.kind === 'analyzer') {
      addRow(
        'channels',
        (() => {
          const span = document.createElement('span');
          span.style.color = '#e7e9ef';
          span.textContent = String(c.channelCount);
          return span;
        })(),
      );
      this.appendPinOrderEditor(body, c);
      body.appendChild(
        this.mkBtn('Add channel', 'Grow the analyzer by one sense pin', () => {
          this.editor?.addAnalyzerChannel(c.id);
        }),
      );
      body.appendChild(
        this.mkBtn(c.armed ? 'Disarm' : 'Arm', 'Toggle analyzer sampling', () => {
          c.armed = !c.armed;
        }),
      );
      const note = document.createElement('div');
      note.style.cssText = 'font:11px ui-monospace,monospace;color:#9aa1b3';
      note.textContent = c.armed ? 'armed — sampling' : 'paused · dblclick opens LA';
      body.appendChild(note);
    }

    if (c.kind === 'busprobe') {
      addRow(
        'width',
        (() => {
          const inp = document.createElement('input');
          inp.type = 'number';
          inp.min = '1';
          inp.max = '32';
          inp.value = String(c.bitWidth);
          inp.style.cssText = 'width:4em;background:#12141a;color:#e7e9ef;border:1px solid #3a4154;border-radius:4px;padding:2px 4px';
          inp.addEventListener('change', () => {
            const n = parseInt(inp.value, 10);
            if (!Number.isFinite(n)) return;
            this.editor?.setBusProbeWidth(c.id, n);
            this.refresh();
          });
          return inp;
        })(),
      );
      addRow(
        'radix',
        (() => {
          const sel = document.createElement('select');
          sel.style.cssText = 'background:#12141a;color:#e7e9ef;border:1px solid #3a4154;border-radius:4px;padding:2px 4px';
          for (const r of ['hex', 'dec', 'bin'] as const) {
            const opt = document.createElement('option');
            opt.value = r;
            opt.textContent = r;
            if (c.radix === r) opt.selected = true;
            sel.appendChild(opt);
          }
          sel.addEventListener('change', () => {
            this.editor?.setBusProbeRadix(c.id, sel.value as 'hex' | 'dec' | 'bin');
            this.refresh();
          });
          return sel;
        })(),
      );
      const note = document.createElement('div');
      note.style.cssText = 'font:11px ui-monospace,monospace;color:#9aa1b3;margin-top:4px';
      note.textContent = 'b0 = LSB · floating/contended → ?';
      body.appendChild(note);
    }
  }

  /** Up/down pin stack reorder for chip / RAM / ROM / analyzer. */
  private appendPinOrderEditor(
    body: HTMLElement,
    c: Component & { pinOrder?: string[]; pins: Record<string, { name: string }> },
  ): void {
    if (!c.pinOrder?.length) c.pinOrder = Object.keys(c.pins);
    const title = document.createElement('div');
    title.style.cssText = 'font:11px ui-monospace,monospace;color:#9aa1b3;margin-top:4px';
    title.textContent = 'pin order';
    body.appendChild(title);
    for (let i = 0; i < c.pinOrder.length; i++) {
      const name = c.pinOrder[i]!;
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '6px';
      const lab = document.createElement('span');
      lab.style.cssText = 'flex:1;font:11px ui-monospace,monospace;color:#e7e9ef';
      lab.textContent = name;
      const up = this.mkBtn('↑', 'Move pin up in stack', () => {
        if (i <= 0) return;
        const order = c.pinOrder!;
        const tmp = order[i - 1]!;
        order[i - 1] = order[i]!;
        order[i] = tmp;
        applyPinLayout(c as Component);
      });
      const down = this.mkBtn('↓', 'Move pin down in stack', () => {
        const order = c.pinOrder!;
        if (i >= order.length - 1) return;
        const tmp = order[i + 1]!;
        order[i + 1] = order[i]!;
        order[i] = tmp;
        applyPinLayout(c as Component);
      });
      up.disabled = i === 0;
      down.disabled = i === c.pinOrder.length - 1;
      row.append(lab, up, down);
      if (c.kind === 'chip' && this.editor) {
        const ed = this.editor;
        const chipId = c.id;
        const pinName = name;
        row.append(
          this.mkBtn('L', 'Pin on left stack', () => {
            ed.setChipPinSide(chipId, pinName, -1);
          }),
          this.mkBtn('R', 'Pin on right stack', () => {
            ed.setChipPinSide(chipId, pinName, 1);
          }),
        );
      }
      body.appendChild(row);
    }
  }
}
