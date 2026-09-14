import type { RamComponent } from '../sim/types.js';
import {
  FB_BASE,
  FB_COLS,
  FB_ROWS,
  FB_SIZE,
  KEY_DATA,
  KEY_STATUS,
  requiresMachineMap,
} from '../machine/memoryMap.js';
import { injectKey } from '../machine/tty.js';

const CELL_W = 10;
const CELL_H = 16;
const PAD = 8;

/**
 * Side-panel text TTY: samples the soft framebuffer in `ram.bytes` and
 * injects keystrokes into KEY_STATUS/KEY_DATA. Not a transistor device.
 */
export class MachinePanel {
  readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly hint: HTMLElement;
  private ram: RamComponent | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(host: HTMLElement) {
    this.root = host;
    this.root.classList.add('machine-panel');
    this.root.innerHTML = `
      <div class="machine-panel-header">
        <span class="machine-panel-title">TTY</span>
        <span class="machine-panel-meta">32×8 · MMIO</span>
      </div>
      <canvas class="machine-panel-canvas" tabindex="0" title="Click to focus; type to inject keys"></canvas>
      <div class="machine-panel-hint">Click panel, then type. Keys overwrite if unread.</div>
    `;
    this.canvas = this.root.querySelector('canvas')!;
    this.hint = this.root.querySelector('.machine-panel-hint')!;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context is not available for MachinePanel');
    this.ctx = ctx;

    const cssW = FB_COLS * CELL_W + PAD * 2;
    const cssH = FB_ROWS * CELL_H + PAD * 2;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.resizeBackingStore();

    this.canvas.addEventListener('click', () => this.canvas.focus());
    this.setVisible(false);
  }

  private resizeBackingStore(): void {
    const dpr = window.devicePixelRatio || 1;
    const cssW = FB_COLS * CELL_W + PAD * 2;
    const cssH = FB_ROWS * CELL_H + PAD * 2;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  attach(ram: RamComponent): void {
    this.detach();
    if (!requiresMachineMap(ram.addrBits)) {
      this.hint.textContent = `Need addrBits ≥ 12 (got ${ram.addrBits}).`;
      this.setVisible(true);
      return;
    }
    this.ram = ram;
    this.keyHandler = (e: KeyboardEvent) => this.onKeyDown(e);
    this.canvas.addEventListener('keydown', this.keyHandler);
    this.hint.textContent = 'Click panel, then type. Keys overwrite if unread.';
    this.setVisible(true);
    this.draw();
  }

  detach(): void {
    if (this.keyHandler) {
      this.canvas.removeEventListener('keydown', this.keyHandler);
      this.keyHandler = null;
    }
    this.ram = null;
    this.setVisible(false);
  }

  get attached(): boolean {
    return this.ram !== null;
  }

  setVisible(show: boolean): void {
    this.root.hidden = !show;
  }

  draw(): void {
    if (!this.ram) return;
    const { ctx, canvas } = this;
    const cssW = canvas.clientWidth || FB_COLS * CELL_W + PAD * 2;
    const cssH = canvas.clientHeight || FB_ROWS * CELL_H + PAD * 2;

    ctx.fillStyle = '#0a0c10';
    ctx.fillRect(0, 0, cssW, cssH);

    ctx.font = `12px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
    ctx.textBaseline = 'top';

    const bytes = this.ram.bytes;
    for (let i = 0; i < FB_SIZE; i++) {
      const col = i % FB_COLS;
      const row = (i / FB_COLS) | 0;
      const code = bytes[FB_BASE + i] ?? 0;
      const ch = code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : code === 0 ? ' ' : '·';
      const x = PAD + col * CELL_W;
      const y = PAD + row * CELL_H;
      ctx.fillStyle = '#1a1f2a';
      ctx.fillRect(x, y, CELL_W - 1, CELL_H - 1);
      ctx.fillStyle = '#c8d0e0';
      ctx.fillText(ch, x + 1, y + 2);
    }

    const status = bytes[KEY_STATUS] ?? 0;
    const data = bytes[KEY_DATA] ?? 0;
    this.root.dataset.keyStatus = String(status);
    this.root.dataset.keyData = `0x${(data & 0xff).toString(16).padStart(2, '0')}`;
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.ram) return;
    const code = mapKey(e);
    if (code === null) return;
    e.preventDefault();
    e.stopPropagation();
    injectKey(this.ram.bytes, code);
    this.draw();
  }
}

/** Map printable keys + Enter/Backspace to a single byte. Returns null to ignore. */
export function mapKey(e: KeyboardEvent): number | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  if (e.key === 'Enter') return 0x0d;
  if (e.key === 'Backspace') return 0x08;
  if (e.key === 'Tab') return 0x09;
  if (e.key.length === 1) {
    const c = e.key.charCodeAt(0);
    if (c >= 0x20 && c < 0x7f) return c;
  }
  return null;
}
