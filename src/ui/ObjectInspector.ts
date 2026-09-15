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
  rotateCcw,
  rotateCw,
  setOrientation,
  type Rotation,
} from '../sim/orientation.js';
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
      this.mkBtn('↻ 90°', 'Rotate all clockwise (R)', () => {
        for (const c of orientable) {
          const { rotation, mirrorX } = getOrientation(c);
          setOrientation(c, rotateCw(rotation as Rotation), mirrorX);
        }
      }),
      this.mkBtn('↺ 90°', 'Rotate all counter-clockwise (Shift+R)', () => {
        for (const c of orientable) {
          const { rotation, mirrorX } = getOrientation(c);
          setOrientation(c, rotateCcw(rotation as Rotation), mirrorX);
        }
      }),
      this.mkBtn('Mirror', 'Mirror all horizontally (M)', () => {
        for (const c of orientable) {
          const { rotation, mirrorX } = getOrientation(c);
          setOrientation(c, rotation as Rotation, !mirrorX);
        }
      }),
    );
    const hint = document.createElement('div');
    hint.style.cssText = 'font:11px ui-monospace,monospace;color:#9aa1b3';
    hint.textContent = 'bulk orient · R / Shift+R / M · Alt+arrows align';
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
          if (!name || name === c.name || !this.library || !this.defId) return;
          this.noteEdit();
          const ok = renamePort(this.library, this.allCircuits, this.defId, c.name, name);
          if (!ok) {
            this.render();
            return;
          }
          this.changed();
        }),
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

    if (c.kind === 'probe') {
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
      this.appendPinOrderEditor(body, c);
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
      const { rotation, mirrorX } = getOrientation(c);
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.flexWrap = 'wrap';
      row.style.gap = '6px';
      row.style.marginTop = '4px';

      row.append(
        this.mkBtn('↻ 90°', 'Rotate clockwise (R)', () => setOrientation(c, rotateCw(rotation as Rotation), mirrorX)),
        this.mkBtn('↺ 90°', 'Rotate counter-clockwise (Shift+R)', () =>
          setOrientation(c, rotateCcw(rotation as Rotation), mirrorX),
        ),
        this.mkBtn(mirrorX ? 'Mirror ✓' : 'Mirror', 'Mirror horizontally (M)', () =>
          setOrientation(c, rotation as Rotation, !mirrorX),
        ),
      );
      const hint = document.createElement('div');
      hint.style.cssText = 'font:11px ui-monospace,monospace;color:#9aa1b3;margin-top:2px';
      hint.textContent = `orient ${rotation}°${mirrorX ? ' · mirrored' : ''} · R / Shift+R / M`;
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
        this.mkBtn(c.armed ? 'Disarm' : 'Arm', 'Toggle analyzer sampling', () => {
          c.armed = !c.armed;
        }),
      );
      const note = document.createElement('div');
      note.style.cssText = 'font:11px ui-monospace,monospace;color:#9aa1b3';
      note.textContent = c.armed ? 'armed — sampling' : 'paused · dblclick opens LA';
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
      body.appendChild(row);
    }
  }
}
