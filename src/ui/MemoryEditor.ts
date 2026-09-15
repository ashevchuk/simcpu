/**
 * Hex memory editor for RamComponent / RomComponent — floating dialog.
 * Pure parse/format helpers are exported for unit tests; the class owns DOM.
 */

import type { MemoryComponent } from '../sim/types.js';
import { FloatingWindow } from './FloatingWindow.js';

export function parseHexBlob(text: string): number[] {
  const cleaned = text.replace(/[^0-9a-fA-F]/g, '');
  const bytes: number[] = [];
  for (let i = 0; i + 1 < cleaned.length; i += 2) {
    bytes.push(parseInt(cleaned.slice(i, i + 2), 16) & 0xff);
  }
  return bytes;
}

export function formatHexDump(bytes: Uint8Array, base = 0, cols = 16): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += cols) {
    const addr = (base + i).toString(16).padStart(4, '0');
    const slice = [...bytes.subarray(i, i + cols)];
    const hex = slice.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = slice.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${addr}  ${hex.padEnd(cols * 3 - 1)}  ${ascii}`);
  }
  return lines.join('\n');
}

export function applyBytes(mem: MemoryComponent, offset: number, data: number[]): number {
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    const addr = offset + i;
    if (addr < 0 || addr >= mem.bytes.length) break;
    mem.bytes[addr] = data[i]! & 0xff;
    n++;
  }
  return n;
}

export class MemoryEditor {
  private readonly win: FloatingWindow;
  readonly root: HTMLElement;
  private mem: MemoryComponent | null = null;
  private readonly gridEl: HTMLTextAreaElement;
  private readonly addrEl: HTMLInputElement;
  private readonly statusEl: HTMLElement;
  private onChange: (() => void) | null = null;

  constructor() {
    this.win = new FloatingWindow('Memory', 'memory-editor');
    this.root = this.win.body;
    this.root.innerHTML = `
      <div class="memory-editor-toolbar">
        <label>@ <input name="addr" size="4" value="0000" spellcheck="false" /></label>
        <button type="button" data-act="goto">Goto</button>
        <button type="button" data-act="apply">Apply hex</button>
        <button type="button" data-act="reload">Reload</button>
        <button type="button" data-act="fill0">Fill 00</button>
        <button type="button" data-act="save-hex">Save .hex</button>
        <button type="button" data-act="load-file">Load file</button>
        <input type="file" data-act="file" accept=".bin,.hex,.txt,application/octet-stream" hidden />
      </div>
      <textarea class="memory-editor-grid" spellcheck="false" rows="16" wrap="off"
        placeholder="addr  hex bytes …  ascii"></textarea>
      <div class="lab-panel-status">Select a RAM/ROM (dblclick) to edit.</div>
    `;
    this.gridEl = this.root.querySelector('.memory-editor-grid')!;
    this.addrEl = this.root.querySelector('input[name="addr"]')!;
    this.statusEl = this.root.querySelector('.lab-panel-status')!;

    this.root.querySelector('[data-act="goto"]')!.addEventListener('click', () => this.scrollToAddr());
    this.root.querySelector('[data-act="apply"]')!.addEventListener('click', () => this.applyFromText());
    this.root.querySelector('[data-act="reload"]')!.addEventListener('click', () => this.refresh());
    this.root.querySelector('[data-act="fill0"]')!.addEventListener('click', () => this.fill(0));
    this.root.querySelector('[data-act="save-hex"]')!.addEventListener('click', () => this.saveHex());
    this.root.querySelector('[data-act="load-file"]')!.addEventListener('click', () => {
      (this.root.querySelector('[data-act="file"]') as HTMLInputElement).click();
    });
    this.root.querySelector('[data-act="file"]')!.addEventListener('change', (ev) => {
      const input = ev.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = '';
      if (file) void this.loadFile(file);
    });
  }

  setOnChange(fn: (() => void) | null): void {
    this.onChange = fn;
  }

  get attached(): boolean {
    return this.mem !== null;
  }

  attach(mem: MemoryComponent): void {
    this.mem = mem;
    this.win.setTitle(mem.kind === 'rom' ? 'ROM' : 'RAM', `${1 << mem.addrBits}×${mem.dataBits}`);
    this.gridEl.readOnly = false;
    this.refresh();
    this.win.setVisible(true);
  }

  detach(): void {
    this.mem = null;
    this.gridEl.value = '';
    this.statusEl.textContent = 'Select a RAM/ROM (dblclick) to edit.';
    this.win.setVisible(false);
  }

  setVisible(show: boolean): void {
    this.win.setVisible(show);
  }

  refresh(): void {
    if (!this.mem) return;
    this.gridEl.value = formatHexDump(this.mem.bytes);
    this.statusEl.textContent = `${this.mem.bytes.length} bytes · edit hex then Apply`;
  }

  private parseAddr(): number {
    const n = parseInt(this.addrEl.value.trim(), 16);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  private scrollToAddr(): void {
    const addr = this.parseAddr();
    const line = Math.floor(addr / 16);
    const lineHeight = this.gridEl.scrollHeight / Math.max(1, this.gridEl.value.split('\n').length);
    this.gridEl.scrollTop = line * lineHeight;
  }

  private applyFromText(): void {
    if (!this.mem) return;
    const raw = this.gridEl.value
      .split('\n')
      .map((line) => {
        const m = /^\s*[0-9a-fA-F]+\s+([0-9a-fA-F\s]+?)(?:\s{2,}.*)?$/.exec(line);
        return m ? m[1]! : line;
      })
      .join(' ');
    const bytes = parseHexBlob(raw);
    if (bytes.length === 0) {
      this.statusEl.textContent = '! no hex bytes found';
      return;
    }
    const n = applyBytes(this.mem, 0, bytes);
    this.refresh();
    this.statusEl.textContent = `wrote ${n} bytes`;
    this.onChange?.();
  }

  private fill(value: number): void {
    if (!this.mem) return;
    this.mem.bytes.fill(value & 0xff);
    this.refresh();
    this.statusEl.textContent = `filled with ${value.toString(16).padStart(2, '0')}`;
    this.onChange?.();
  }

  private saveHex(): void {
    if (!this.mem) return;
    const blob = new Blob([formatHexDump(this.mem.bytes)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.mem.kind}-${1 << this.mem.addrBits}.hex`;
    a.click();
    URL.revokeObjectURL(url);
  }

  private async loadFile(file: File): Promise<void> {
    if (!this.mem) return;
    const buf = await file.arrayBuffer();
    const isText = /\.(hex|txt)$/i.test(file.name) || file.type.startsWith('text/');
    let data: number[];
    if (isText) {
      data = parseHexBlob(new TextDecoder().decode(buf));
    } else {
      data = [...new Uint8Array(buf)];
    }
    const n = applyBytes(this.mem, this.parseAddr(), data);
    this.refresh();
    this.statusEl.textContent = `loaded ${n} bytes from ${file.name}`;
    this.onChange?.();
  }
}
