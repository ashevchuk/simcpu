/**
 * Floating watch list — pinned schematic pin ids with live levels (0/1/Z/X),
 * plus optional multi-bit bus rows (hex/dec).
 */

import { FloatingWindow } from './FloatingWindow.js';

export type WatchLevel = 0 | 1 | 'Z' | 'X';

export interface WatchEntry {
  pinId: string;
  label: string;
  level: WatchLevel;
}

export interface WatchBusGroup {
  id: string;
  label: string;
  /** Pin ids LSB-first (index 0 = bit 0). */
  pinIds: string[];
}

export class WatchList {
  private readonly win: FloatingWindow;
  readonly root: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly laEl: HTMLElement;
  private readonly breakContendEl: HTMLInputElement;
  private readonly breakWatchEl: HTMLInputElement;
  private pinIds: string[] = [];
  private buses: WatchBusGroup[] = [];
  private levels = new Map<string, WatchLevel>();
  private labels = new Map<string, string>();
  /** Live row level cells — updated in place so sim ticks don't destroy × buttons. */
  private readonly lvlEls = new Map<string, HTMLElement>();
  private readonly busLvlEls = new Map<string, HTMLElement>();

  /** Fired when the pin set changes (add/remove). */
  onChange: (() => void) | null = null;
  /** Fired when a row is clicked — select that pin's component. */
  onSelectPin: ((pinId: string) => void) | null = null;
  /** Right-click on a bus row — spawn probe / wire to LA. */
  onBusContext: ((bus: WatchBusGroup, clientX: number, clientY: number) => void) | null = null;

  constructor() {
    this.win = new FloatingWindow('Watch List', 'watch-list');
    this.root = this.win.body;
    this.root.innerHTML = `
      <div class="watch-list-toolbar">
        <label class="watch-list-toggle"><input type="checkbox" data-act="break-contend" /> Break on contend</label>
        <label class="watch-list-toggle"><input type="checkbox" data-act="break-watch" /> Break on watch change</label>
      </div>
      <div class="watch-list-rows" data-act="rows"></div>
      <div class="watch-list-la" data-act="la" hidden></div>
      <div class="lab-panel-status">Ctrl+W or context menu · Watch pin / bus</div>
    `;
    this.listEl = this.root.querySelector('[data-act="rows"]')!;
    this.laEl = this.root.querySelector('[data-act="la"]')!;
    this.breakContendEl = this.root.querySelector('[data-act="break-contend"]')!;
    this.breakWatchEl = this.root.querySelector('[data-act="break-watch"]')!;
    this.win.setTitle('Watch List', '');
  }

  get breakOnContend(): boolean {
    return this.breakContendEl.checked;
  }

  set breakOnContend(v: boolean) {
    this.breakContendEl.checked = v;
  }

  get breakOnWatchChange(): boolean {
    return this.breakWatchEl.checked;
  }

  set breakOnWatchChange(v: boolean) {
    this.breakWatchEl.checked = v;
  }

  getPinIds(): readonly string[] {
    return this.pinIds;
  }

  getBuses(): readonly WatchBusGroup[] {
    return this.buses;
  }

  has(pinId: string): boolean {
    return this.pinIds.includes(pinId);
  }

  add(pinId: string, label?: string): boolean {
    if (!pinId || this.pinIds.includes(pinId)) return false;
    this.pinIds.push(pinId);
    if (label) this.labels.set(pinId, label);
    else if (!this.labels.has(pinId)) this.labels.set(pinId, shortPinLabel(pinId));
    this.renderRows();
    this.onChange?.();
    return true;
  }

  /** Group pins as a bus row (LSB-first). Returns false if fewer than 2 pins. */
  addBus(pinIds: string[], label?: string): boolean {
    const ids = [...new Set(pinIds.filter(Boolean))];
    if (ids.length < 2) return false;
    const id = `bus:${ids.join('|')}`;
    if (this.buses.some((b) => b.id === id)) return false;
    const prefix = busPrefixLabel(ids);
    this.buses.push({
      id,
      label: label ?? prefix,
      pinIds: ids,
    });
    this.renderRows();
    this.onChange?.();
    return true;
  }

  removeBus(busId: string): void {
    const i = this.buses.findIndex((b) => b.id === busId);
    if (i < 0) return;
    this.buses.splice(i, 1);
    this.busLvlEls.delete(busId);
    this.renderRows();
    this.onChange?.();
  }

  remove(pinId: string): void {
    const i = this.pinIds.indexOf(pinId);
    if (i < 0) return;
    this.pinIds.splice(i, 1);
    this.levels.delete(pinId);
    this.labels.delete(pinId);
    this.lvlEls.delete(pinId);
    this.renderRows();
    this.onChange?.();
  }

  /** Drop watches whose pin belongs to any of the given component ids (`compId:pin`). */
  removeComponents(componentIds: Iterable<string>): void {
    const gone = new Set(componentIds);
    if (gone.size === 0) return;
    const next = this.pinIds.filter((id) => !gone.has(id.split(':')[0]!));
    const nextBuses = this.buses.filter((b) => !b.pinIds.some((id) => gone.has(id.split(':')[0]!)));
    if (next.length === this.pinIds.length && nextBuses.length === this.buses.length) return;
    this.pinIds = next;
    this.buses = nextBuses;
    for (const id of [...this.levels.keys()]) {
      if (!this.pinIds.includes(id) && !this.buses.some((b) => b.pinIds.includes(id))) {
        this.levels.delete(id);
        this.labels.delete(id);
        this.lvlEls.delete(id);
      }
    }
    this.renderRows();
    this.onChange?.();
  }

  clear(): void {
    this.pinIds = [];
    this.buses = [];
    this.levels.clear();
    this.labels.clear();
    this.lvlEls.clear();
    this.busLvlEls.clear();
    this.renderRows();
    this.onChange?.();
  }

  setPinIds(ids: string[]): void {
    this.pinIds = [...new Set(ids.filter(Boolean))];
    for (const id of this.pinIds) {
      if (!this.labels.has(id)) this.labels.set(id, shortPinLabel(id));
    }
    for (const id of [...this.levels.keys()]) {
      if (!this.pinIds.includes(id)) {
        this.levels.delete(id);
        this.labels.delete(id);
        this.lvlEls.delete(id);
      }
    }
    this.renderRows();
  }

  setLabel(pinId: string, label: string): void {
    this.labels.set(pinId, label);
    const nameBtn = this.listEl.querySelector(`[data-pin-id="${cssEscape(pinId)}"] .watch-list-name`);
    if (nameBtn) nameBtn.textContent = label;
  }

  /** Update live levels from the sim resolve path. Returns pin ids whose level changed. */
  updateLevels(
    resolve: (localPinId: string) => { level: 0 | 1 | 'Z'; contended: boolean },
  ): string[] {
    const changed: string[] = [];
    const allPins = new Set([...this.pinIds, ...this.buses.flatMap((b) => b.pinIds)]);
    for (const pinId of allPins) {
      const { level, contended } = resolve(pinId);
      const next: WatchLevel = contended ? 'X' : level;
      const prev = this.levels.get(pinId);
      if (prev !== undefined && prev !== next) changed.push(pinId);
      this.levels.set(pinId, next);
      const lvlEl = this.lvlEls.get(pinId);
      if (lvlEl) {
        const text = String(next);
        if (lvlEl.dataset.lvl !== text) {
          lvlEl.dataset.lvl = text;
          lvlEl.textContent = text;
        }
      }
    }
    for (const bus of this.buses) {
      const el = this.busLvlEls.get(bus.id);
      if (!el) continue;
      const text = formatBusValue(bus.pinIds.map((id) => this.levels.get(id) ?? 'Z'));
      if (el.dataset.lvl !== text) {
        el.dataset.lvl = text;
        el.textContent = text;
      }
    }
    // First paint / empty→nonempty without a prior renderRows.
    if ((this.pinIds.length > 0 || this.buses.length > 0) && this.lvlEls.size === 0 && this.busLvlEls.size === 0) {
      this.renderRows();
    }
    return changed;
  }

  /** Show analyzer cursor channel levels (or hide when null). */
  setAnalyzerCursor(levels: { ch: number; level: string }[] | null): void {
    if (!levels || levels.length === 0) {
      this.laEl.hidden = true;
      this.laEl.replaceChildren();
      return;
    }
    this.laEl.hidden = false;
    this.laEl.replaceChildren();
    const title = document.createElement('div');
    title.className = 'watch-list-la-title';
    title.textContent = 'LA cursor';
    this.laEl.appendChild(title);
    for (const row of levels) {
      const el = document.createElement('div');
      el.className = 'watch-list-row';
      el.innerHTML = `<span class="watch-list-name">ch${row.ch}</span><span class="watch-list-lvl" data-lvl="${row.level}">${row.level}</span>`;
      this.laEl.appendChild(el);
    }
  }

  setVisible(show: boolean): void {
    this.win.setVisible(show);
    if (show) this.renderRows();
  }

  get visible(): boolean {
    return this.win.visible;
  }

  private renderRows(): void {
    this.listEl.replaceChildren();
    this.lvlEls.clear();
    this.busLvlEls.clear();
    const count = this.pinIds.length + this.buses.length;
    this.win.setTitle('Watch List', count ? `${count}` : '');
    if (count === 0) {
      const empty = document.createElement('div');
      empty.className = 'watch-list-empty';
      empty.textContent = 'No watched pins';
      this.listEl.appendChild(empty);
      return;
    }
    for (const bus of this.buses) {
      const row = document.createElement('div');
      row.className = 'watch-list-row watch-list-bus';
      row.dataset.busId = bus.id;
      row.title = bus.pinIds.join(', ');
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'watch-list-name';
      name.textContent = bus.label;
      name.addEventListener('click', () => this.onSelectPin?.(bus.pinIds[0]!));
      const lvl = document.createElement('span');
      lvl.className = 'watch-list-lvl';
      const text = formatBusValue(bus.pinIds.map((id) => this.levels.get(id) ?? 'Z'));
      lvl.dataset.lvl = text;
      lvl.textContent = text;
      this.busLvlEls.set(bus.id, lvl);
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'watch-list-rm';
      rm.title = 'Remove bus';
      rm.textContent = '×';
      rm.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.removeBus(bus.id);
      });
      row.append(name, lvl, rm);
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        this.onBusContext?.(bus, ev.clientX, ev.clientY);
      });
      this.listEl.appendChild(row);
    }
    for (const pinId of this.pinIds) {
      const row = document.createElement('div');
      row.className = 'watch-list-row';
      row.dataset.pinId = pinId;
      row.title = pinId;
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'watch-list-name';
      name.textContent = this.labels.get(pinId) ?? shortPinLabel(pinId);
      name.addEventListener('click', () => this.onSelectPin?.(pinId));
      const lvl = document.createElement('span');
      lvl.className = 'watch-list-lvl';
      const v = this.levels.get(pinId) ?? 'Z';
      lvl.dataset.lvl = String(v);
      lvl.textContent = String(v);
      this.lvlEls.set(pinId, lvl);
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'watch-list-rm';
      rm.title = 'Remove';
      rm.textContent = '×';
      rm.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.remove(pinId);
      });
      row.append(name, lvl, rm);
      this.listEl.appendChild(row);
    }
  }
}

function shortPinLabel(pinId: string): string {
  const colon = pinId.lastIndexOf(':');
  if (colon >= 0) return pinId.slice(colon + 1) || pinId;
  return pinId;
}

function busPrefixLabel(pinIds: string[]): string {
  const names = pinIds.map(shortPinLabel);
  const m = names[0]?.match(/^([a-zA-Z_]+)\d+$/);
  if (m) return `${m[1]}[${names.length - 1}:0]`;
  return `bus×${names.length}`;
}

/** LSB-first levels → "0xN (d)" or partial if Z/X present. */
export function formatBusValue(levels: WatchLevel[]): string {
  let v = 0;
  let ok = true;
  for (let i = 0; i < levels.length; i++) {
    const lvl = levels[i]!;
    if (lvl !== 0 && lvl !== 1) {
      ok = false;
      break;
    }
    v |= lvl << i;
  }
  if (!ok) return levels.map(String).join('');
  const hex = `0x${v.toString(16).toUpperCase()}`;
  return `${hex} (${v})`;
}

/**
 * Collect consecutive numbered pins on a chip with the same letter prefix
 * as `pinName` (e.g. q0 → q0..qN). Returns LSB-first pin ids, or [] if under 2.
 */
export function consecutiveBusPins(
  pins: Record<string, { id: string }>,
  pinName: string,
): string[] {
  const m = pinName.match(/^([a-zA-Z_]+)(\d+)$/);
  if (!m) return [];
  const prefix = m[1]!;
  const indices: number[] = [];
  for (const name of Object.keys(pins)) {
    const mm = name.match(new RegExp(`^${prefix}(\\d+)$`));
    if (mm) indices.push(Number(mm[1]));
  }
  if (indices.length < 2) return [];
  indices.sort((a, b) => a - b);
  // Require contiguous from 0 or from min.
  const start = indices[0]!;
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] !== start + i) {
      indices.length = i;
      break;
    }
  }
  if (indices.length < 2) return [];
  return indices.map((i) => pins[`${prefix}${i}`]!.id);
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
