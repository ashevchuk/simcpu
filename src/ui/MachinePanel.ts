import type { RamComponent } from '../sim/types.js';
import type { MachineRunner, RunSpeed } from '../machine/MachineRunner.js';
import {
  FB_BASE,
  FB_COLS,
  FB_ROWS,
  FB_SIZE,
  KEY_DATA,
  KEY_STATUS,
  requiresMachineMap,
} from '../machine/memoryMap.js';
import { loadHexAt, parseHex, parseHexBlob, runSoftCommand } from '../machine/softConsole.js';
import { injectKey } from '../machine/tty.js';

const CELL_W = 10;
const CELL_H = 16;
const PAD = 8;

/**
 * Side-panel text TTY + soft command/load console. Run/Pause/Step drive a
 * MachineRunner auto-clock. Not a transistor device.
 */
export class MachinePanel {
  readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly hint: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly outEl: HTMLElement;
  private readonly cmdInput: HTMLInputElement;
  private readonly loadAddr: HTMLInputElement;
  private readonly loadHex: HTMLTextAreaElement;
  private readonly speedSel: HTMLSelectElement;
  private readonly btnRun: HTMLButtonElement;
  private readonly btnPause: HTMLButtonElement;
  private readonly btnStep: HTMLButtonElement;
  private readonly btnReboot: HTMLButtonElement;
  private ram: RamComponent | null = null;
  private runner: MachineRunner | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(host: HTMLElement) {
    this.root = host;
    this.root.classList.add('machine-panel');
    this.root.innerHTML = `
      <div class="machine-panel-header">
        <span class="machine-panel-title">TTY</span>
        <span class="machine-panel-meta">32×8 · soft console</span>
      </div>
      <div class="machine-panel-controls">
        <button type="button" data-act="run" title="Auto-clock">Run</button>
        <button type="button" data-act="pause" title="Pause auto-clock">Pause</button>
        <button type="button" data-act="step" title="One full instruction (10 phases)">Step</button>
        <button type="button" data-act="reboot" title="Reset PC via runner reboot">Reboot</button>
        <label class="machine-panel-speed">Speed
          <select data-act="speed" title="FSM phases per animation frame">
            <option value="slow">Slow (2)</option>
            <option value="normal" selected>Normal (10)</option>
            <option value="turbo">Turbo (40)</option>
          </select>
        </label>
        <span class="machine-panel-status">idle</span>
      </div>
      <canvas class="machine-panel-canvas" tabindex="0" title="Click to focus; type to inject keys"></canvas>
      <form class="machine-panel-cmd" autocomplete="off">
        <label>Cmd <input name="cmd" spellcheck="false" placeholder="H | M e00 8 | W 100 3e 00 | G 100 | R" /></label>
        <button type="submit">Enter</button>
      </form>
      <div class="machine-panel-load">
        <label>Load @ <input name="addr" spellcheck="false" value="0100" size="4" /></label>
        <textarea name="hex" rows="3" spellcheck="false" placeholder="hex bytes: 3e,41,32,00,0e ..."></textarea>
        <button type="button" data-act="load">Load hex</button>
      </div>
      <pre class="machine-panel-out"></pre>
      <div class="machine-panel-hint">Z80 echo on canvas keys; soft Cmd/Load mutate RAM. First boot is slow.</div>
    `;
    this.canvas = this.root.querySelector('canvas')!;
    this.hint = this.root.querySelector('.machine-panel-hint')!;
    this.statusEl = this.root.querySelector('.machine-panel-status')!;
    this.outEl = this.root.querySelector('.machine-panel-out')!;
    this.cmdInput = this.root.querySelector('input[name="cmd"]')!;
    this.loadAddr = this.root.querySelector('input[name="addr"]')!;
    this.loadHex = this.root.querySelector('textarea[name="hex"]')!;
    this.speedSel = this.root.querySelector('[data-act="speed"]')!;
    this.btnRun = this.root.querySelector('[data-act="run"]')!;
    this.btnPause = this.root.querySelector('[data-act="pause"]')!;
    this.btnStep = this.root.querySelector('[data-act="step"]')!;
    this.btnReboot = this.root.querySelector('[data-act="reboot"]')!;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context is not available for MachinePanel');
    this.ctx = ctx;

    const cssW = FB_COLS * CELL_W + PAD * 2;
    const cssH = FB_ROWS * CELL_H + PAD * 2;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.resizeBackingStore();

    this.canvas.addEventListener('click', () => this.canvas.focus());
    this.btnRun.addEventListener('click', () => {
      this.runner?.setRunning(true);
      this.refreshControls();
    });
    this.btnPause.addEventListener('click', () => {
      this.runner?.setRunning(false);
      this.refreshControls();
    });
    this.btnStep.addEventListener('click', () => {
      this.runner?.stepInstruction();
      this.draw();
      this.refreshControls();
    });
    this.btnReboot.addEventListener('click', () => {
      this.runner?.reboot();
      this.log('reboot');
      this.draw();
      this.refreshControls();
    });
    this.speedSel.addEventListener('change', () => {
      const v = this.speedSel.value as RunSpeed;
      this.runner?.setSpeed(v);
      this.refreshControls();
    });
    this.root.querySelector('.machine-panel-cmd')!.addEventListener('submit', (e) => {
      e.preventDefault();
      this.runCommandLine(this.cmdInput.value);
      this.cmdInput.select();
    });
    this.root.querySelector('[data-act="load"]')!.addEventListener('click', () => this.doLoadHex());
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

  private log(msg: string): void {
    if (!msg) return;
    const prev = this.outEl.textContent ?? '';
    const next = prev ? `${prev}\n${msg}` : msg;
    const lines = next.split('\n');
    this.outEl.textContent = lines.slice(-12).join('\n');
  }

  private runCommandLine(line: string): void {
    if (!this.ram) {
      this.log('no RAM attached');
      return;
    }
    const result = runSoftCommand(this.ram.bytes, line);
    this.log(result.ok ? result.message || 'ok' : `! ${result.message}`);
    if (result.reboot) {
      this.runner?.reboot();
      this.runner?.setRunning(true);
    }
    this.draw();
    this.refreshControls();
  }

  private doLoadHex(): void {
    if (!this.ram) {
      this.log('no RAM attached');
      return;
    }
    const addr = parseHex(this.loadAddr.value);
    if (addr === null) {
      this.log('! bad load address');
      return;
    }
    const blob = parseHexBlob(this.loadHex.value);
    if (!blob) {
      this.log('! bad hex blob');
      return;
    }
    const result = loadHexAt(this.ram.bytes, addr, blob);
    this.log(result.ok ? result.message : `! ${result.message}`);
    this.draw();
  }

  bindRunner(runner: MachineRunner | null): void {
    this.runner = runner;
    if (runner) {
      this.speedSel.value = runner.speed;
    }
    this.refreshControls();
  }

  attach(ram: RamComponent): void {
    this.detachRamOnly();
    if (!requiresMachineMap(ram.addrBits)) {
      this.hint.textContent = `Need addrBits ≥ 12 (got ${ram.addrBits}).`;
      this.setVisible(true);
      this.refreshControls();
      return;
    }
    this.ram = ram;
    this.keyHandler = (e: KeyboardEvent) => this.onKeyDown(e);
    this.canvas.addEventListener('keydown', this.keyHandler);
    this.hint.textContent =
      'Canvas keys → Z80 echo. Cmd: M/W/G/R/H. Load hex into RAM. Speed = phases/frame; first boot slow.';
    this.setVisible(true);
    this.draw();
    this.refreshControls();
  }

  private detachRamOnly(): void {
    if (this.keyHandler) {
      this.canvas.removeEventListener('keydown', this.keyHandler);
      this.keyHandler = null;
    }
    this.ram = null;
  }

  detach(): void {
    this.detachRamOnly();
    this.runner = null;
    this.setVisible(false);
    this.refreshControls();
  }

  get attached(): boolean {
    return this.ram !== null;
  }

  setVisible(show: boolean): void {
    this.root.hidden = !show;
  }

  refreshControls(): void {
    const has = this.runner?.attached ?? false;
    this.btnRun.disabled = !has;
    this.btnPause.disabled = !has;
    this.btnStep.disabled = !has;
    this.btnReboot.disabled = !has;
    this.speedSel.disabled = !has;
    this.cmdInput.disabled = !this.ram;
    this.loadAddr.disabled = !this.ram;
    this.loadHex.disabled = !this.ram;
    if (!has) {
      this.statusEl.textContent = 'idle';
      return;
    }
    const spd = this.runner!.speed;
    this.statusEl.textContent = `${this.runner!.running ? 'run' : 'pause'} · ${spd} ${this.runner!.phasesPerFrame}/f`;
    this.btnRun.classList.toggle('active', this.runner!.running);
    this.btnPause.classList.toggle('active', !this.runner!.running);
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
    // Don't steal keys while typing in cmd/load fields.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
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
