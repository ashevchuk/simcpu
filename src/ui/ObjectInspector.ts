/**
 * Object inspector — configure the selected component (labels, button mode,
 * pulse timing, orientation, …) without modal prompts.
 */

import type { Circuit } from '../sim/Circuit.js';
import type { ChipLibrary } from '../sim/ChipLibrary.js';
import { renamePort } from '../sim/hierarchy.js';
import {
  getOrientation,
  isOrientable,
  rotateCcw,
  rotateCw,
  setOrientation,
  type Rotation,
} from '../sim/orientation.js';
import type { Component } from '../sim/types.js';
import { FloatingWindow } from './FloatingWindow.js';

export class ObjectInspector {
  private readonly win = new FloatingWindow('Inspector');
  private target: Component | null = null;
  private lastSyncedId: string | null = null;
  private circuit: Circuit | null = null;
  private library: ChipLibrary | null = null;
  /** ChipDef id when editing inside a folded chip (for port rename). */
  private defId: string | null = null;
  private allCircuits: Circuit[] = [];
  onChange: (() => void) | null = null;
  onBeforeEdit: (() => void) | null = null;

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

  /** Show inspector for one component, or hide when nothing / multi-select. */
  sync(selected: Component | null, force = false): void {
    const id = selected?.id ?? null;
    if (!force && id === this.lastSyncedId) {
      this.target = selected;
      if (!selected) this.win.setVisible(false);
      return;
    }
    this.lastSyncedId = id;
    if (!selected) {
      this.target = null;
      this.win.setVisible(false);
      return;
    }
    this.target = selected;
    this.win.setTitle('Inspector', selected.kind);
    this.render();
    this.win.setVisible(true);
  }

  /** Rebuild form for the current target (after rotate from keyboard, etc.). */
  refresh(): void {
    if (this.target) this.render();
  }

  private noteEdit(): void {
    this.onBeforeEdit?.();
  }

  private changed(): void {
    this.onChange?.();
    this.render();
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

    if (isOrientable(c)) {
      const { rotation, mirrorX } = getOrientation(c);
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.flexWrap = 'wrap';
      row.style.gap = '6px';
      row.style.marginTop = '4px';

      const mkBtn = (label: string, title: string, fn: () => void) => {
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
      };

      row.append(
        mkBtn('↻ 90°', 'Rotate clockwise (R)', () => setOrientation(c, rotateCw(rotation as Rotation), mirrorX)),
        mkBtn('↺ 90°', 'Rotate counter-clockwise (Shift+R)', () =>
          setOrientation(c, rotateCcw(rotation as Rotation), mirrorX),
        ),
        mkBtn(mirrorX ? 'Mirror ✓' : 'Mirror', 'Mirror horizontally (M)', () =>
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
        numInput(
          c.channelCount,
          (n) => {
            // Channel count is structural (pins); keep read-only here — use place dialog.
            void n;
          },
          1,
          64,
        ),
      );
      const note = document.createElement('div');
      note.style.cssText = 'font:11px ui-monospace,monospace;color:#9aa1b3';
      note.textContent = c.armed ? 'armed — sampling' : 'paused · dblclick opens LA';
      body.appendChild(note);
    }
  }
}
