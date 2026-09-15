import type { RamComponent } from '../sim/types.js';
import type { MachineRunner, RunSpeed } from '../machine/MachineRunner.js';
import {
  BMP_HEIGHT,
  BMP_WIDTH,
  FB_BASE,
  FB_COLS,
  FB_ROWS,
  FB_SIZE,
  KEY_DATA,
  KEY_STATUS,
  requiresMachineMap,
} from '../machine/memoryMap.js';
import { assemble, bytesToHexPrompt } from '../machine/assembler.js';
import { compileBasic } from '../machine/basic.js';
import { loadHexAt, parseHex, parseHexBlob, runSoftCommand } from '../machine/softConsole.js';
import { injectKey } from '../machine/tty.js';
import { FloatingWindow } from './FloatingWindow.js';

const CELL_W = 10;
const CELL_H = 16;
const PAD = 8;
const BMP_SCALE = 2;
const BMP_GAP = 6;

/**
 * Floating TTY + soft command/load console. Run/Pause/Step drive a
 * MachineRunner auto-clock. Opened by dblclick on a TTY component.
 */
export class MachinePanel {
  private readonly win: FloatingWindow;
  readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly hint: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly outEl: HTMLElement;
  private readonly cmdInput: HTMLInputElement;
  private readonly loadAddr: HTMLInputElement;
  private readonly loadHex: HTMLTextAreaElement;
  private readonly asmSource: HTMLTextAreaElement;
  private readonly speedSel: HTMLSelectElement;
  private readonly btnRun: HTMLButtonElement;
  private readonly btnPause: HTMLButtonElement;
  private readonly btnStep: HTMLButtonElement;
  private readonly btnReboot: HTMLButtonElement;
  private ram: RamComponent | null = null;
  private runner: MachineRunner | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  private readonly bmpTmp: HTMLCanvasElement = document.createElement('canvas');
  private bmpTmpCtx!: CanvasRenderingContext2D;

  constructor() {
    this.win = new FloatingWindow('TTY', 'machine-panel');
    this.win.setTitle('TTY', '32×8 · 128×64 bmp · asm/basic');
    this.root = this.win.body;
    this.root.innerHTML = `
      <div class="machine-panel-controls">
        <button type="button" data-act="run" title="Auto-clock">Run</button>
        <button type="button" data-act="pause" title="Pause auto-clock">Pause</button>
        <button type="button" data-act="step" title="One full instruction (10 phases)">Step</button>
        <button type="button" data-act="reboot" title="Reset PC via runner reboot">Reboot</button>
        <label class="machine-panel-speed">Speed
          <select data-act="speed" title="Soft = interpreter (fast TTY). Gates = transistor (slow).">
            <option value="soft" selected>Soft (fast)</option>
            <option value="slow">Gates slow</option>
            <option value="normal">Gates normal</option>
            <option value="turbo">Gates turbo</option>
            <option value="free">Gates free</option>
          </select>
        </label>
        <span class="machine-panel-status">idle</span>
      </div>
      <canvas class="machine-panel-canvas" tabindex="0" title="Click to focus; type to inject keys"></canvas>
      <form class="machine-panel-cmd" autocomplete="off">
        <label>Cmd <input name="cmd" spellcheck="false" placeholder="host: H | M e00 8 | W 100 3e | G 200 | R" /></label>
        <button type="submit">Enter</button>
      </form>
      <div class="machine-panel-load">
        <label>Load @ <input name="addr" spellcheck="false" value="0200" size="4" /></label>
        <textarea name="hex" rows="2" spellcheck="false" placeholder="hex: 3e,41,32,00,0e ..."></textarea>
        <button type="button" data-act="load">Load hex</button>
      </div>
      <div class="machine-panel-asm">
        <textarea name="asm" rows="5" spellcheck="false">; origin = Load @ (try 0200)
LD A,'A'
LD (0xE00),A
spin:
JR spin</textarea>
        <div class="machine-panel-asm-actions">
          <button type="button" data-act="asm">Assemble → Load @</button>
          <button type="button" data-act="asm-go" title="Assemble, load, G origin, reboot">Assemble + Go</button>
          <button type="button" data-act="basic" title="Compile mini-BASIC from the text area">BASIC → Load @</button>
        </div>
      </div>
      <pre class="machine-panel-out"></pre>
      <div class="machine-panel-hint">Soft Run = fast Z80 on RAM (+ports/bitmap). Gates = transistor. TTY H/M/W/G.</div>
    `;
    this.canvas = this.root.querySelector('canvas')!;
    this.hint = this.root.querySelector('.machine-panel-hint')!;
    this.statusEl = this.root.querySelector('.machine-panel-status')!;
    this.outEl = this.root.querySelector('.machine-panel-out')!;
    this.cmdInput = this.root.querySelector('input[name="cmd"]')!;
    this.loadAddr = this.root.querySelector('input[name="addr"]')!;
    this.loadHex = this.root.querySelector('textarea[name="hex"]')!;
    this.asmSource = this.root.querySelector('textarea[name="asm"]')!;
    this.speedSel = this.root.querySelector('[data-act="speed"]')!;
    this.btnRun = this.root.querySelector('[data-act="run"]')!;
    this.btnPause = this.root.querySelector('[data-act="pause"]')!;
    this.btnStep = this.root.querySelector('[data-act="step"]')!;
    this.btnReboot = this.root.querySelector('[data-act="reboot"]')!;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context is not available for MachinePanel');
    this.ctx = ctx;
    this.bmpTmp.width = BMP_WIDTH;
    this.bmpTmp.height = BMP_HEIGHT;
    const bmpCtx = this.bmpTmp.getContext('2d');
    if (!bmpCtx) throw new Error('2D canvas context is not available for bitmap blit');
    this.bmpTmpCtx = bmpCtx;
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
      const prev = this.runner?.speed;
      const v = this.speedSel.value as RunSpeed;
      this.runner?.setSpeed(v);
      if (prev === 'soft' && v !== 'soft' && this.runner?.softDesynced) {
        this.runner.reboot();
        this.log('reboot (resync after soft)');
        this.draw();
      }
      this.refreshControls();
    });
    this.root.querySelector('.machine-panel-cmd')!.addEventListener('submit', (e) => {
      e.preventDefault();
      this.runCommandLine(this.cmdInput.value);
      this.cmdInput.select();
    });
    this.root.querySelector('[data-act="load"]')!.addEventListener('click', () => this.doLoadHex());
    this.root.querySelector('[data-act="asm"]')!.addEventListener('click', () => this.doAssemble(false));
    this.root.querySelector('[data-act="asm-go"]')!.addEventListener('click', () => this.doAssemble(true));
    this.root.querySelector('[data-act="basic"]')!.addEventListener('click', () => this.doBasic());
  }

  private panelCssSize(): { cssW: number; cssH: number } {
    const cssW = Math.max(FB_COLS * CELL_W, BMP_WIDTH * BMP_SCALE) + PAD * 2;
    const cssH = FB_ROWS * CELL_H + PAD * 2 + BMP_GAP + BMP_HEIGHT * BMP_SCALE + PAD;
    return { cssW, cssH };
  }

  private resizeBackingStore(): void {
    const dpr = window.devicePixelRatio || 1;
    const { cssW, cssH } = this.panelCssSize();
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private log(msg: string): void {
    if (!msg) return;
    const prev = this.outEl.textContent ?? '';
    const next = prev ? `${prev}\n${msg}` : msg;
    const lines = next.split('\n');
    this.outEl.textContent = lines.slice(-24).join('\n');
  }

  private doAssemble(go: boolean): void {
    if (!this.ram) {
      this.log('no RAM attached');
      return;
    }
    const addr = parseHex(this.loadAddr.value);
    if (addr === null) {
      this.log('! bad Load @ address (used as asm origin)');
      return;
    }
    const result = assemble(this.asmSource.value, addr);
    if (!result.ok) {
      for (const err of result.errors) this.log(`! ${err}`);
      return;
    }
    for (const line of result.listing) this.log(line);
    this.loadHex.value = bytesToHexPrompt(result.bytes);
    const loaded = loadHexAt(this.ram.bytes, addr, [...result.bytes]);
    this.log(loaded.ok ? loaded.message : `! ${loaded.message}`);
    if (!loaded.ok) return;
    if (go) {
      const g = runSoftCommand(this.ram.bytes, `G ${addr.toString(16)}`);
      this.log(g.message);
      if (g.reboot) {
        this.runner?.reboot();
        this.runner?.setRunning(true);
      }
    }
    this.draw();
    this.refreshControls();
  }

  private doBasic(): void {
    if (!this.ram) {
      this.log('no RAM attached');
      return;
    }
    const addr = parseHex(this.loadAddr.value);
    if (addr === null) {
      this.log('! bad Load @ address (used as BASIC origin)');
      return;
    }
    try {
      const bytes = compileBasic(this.asmSource.value, addr);
      this.loadHex.value = bytesToHexPrompt(bytes);
      const loaded = loadHexAt(this.ram.bytes, addr, [...bytes]);
      this.log(loaded.ok ? `BASIC ${bytes.length}B @ ${addr.toString(16)}` : `! ${loaded.message}`);
      this.draw();
      this.refreshControls();
    } catch (e) {
      this.log(`! ${e instanceof Error ? e.message : String(e)}`);
    }
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
      this.win.setVisible(true);
      this.refreshControls();
      return;
    }
    this.ram = ram;
    this.keyHandler = (e: KeyboardEvent) => this.onKeyDown(e);
    this.canvas.addEventListener('keydown', this.keyHandler);
    this.hint.textContent =
      'Soft Run = fast TTY. Gates = real transistors (slow). Asm → Load @ (≥200h).';
    this.win.setVisible(true);
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
    this.win.setVisible(false);
    this.refreshControls();
  }

  get attached(): boolean {
    return this.ram !== null;
  }

  setVisible(show: boolean): void {
    this.win.setVisible(show);
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
    this.asmSource.disabled = !this.ram;
    if (!has) {
      this.statusEl.textContent = 'idle';
      return;
    }
    const spd = this.runner!.speed;
    const desync = this.runner!.softDesynced && spd !== 'soft' ? ' · desync' : '';
    const soft = this.runner!.softCpu;
    const softPc =
      spd === 'soft' && soft ? ` · PC=${soft.pc.toString(16).padStart(4, '0')}` : '';
    const err = this.runner!.softError ? ` · !${this.runner!.softError.slice(0, 40)}` : '';
    this.statusEl.textContent = `${this.runner!.running ? 'run' : 'pause'} · ${spd}${softPc}${desync}${err}`;
    this.btnRun.classList.toggle('active', this.runner!.running);
    this.btnPause.classList.toggle('active', !this.runner!.running);
  }

  draw(): void {
    if (!this.ram) return;
    const { ctx, canvas } = this;
    const { cssW, cssH } = this.panelCssSize();
    if (canvas.clientWidth !== cssW || canvas.clientHeight !== cssH) this.resizeBackingStore();

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

    const bmpY = PAD + FB_ROWS * CELL_H + BMP_GAP;
    const bmp = this.runner?.softDevices.bitmap;
    ctx.fillStyle = '#12151c';
    ctx.fillRect(PAD, bmpY, BMP_WIDTH * BMP_SCALE, BMP_HEIGHT * BMP_SCALE);
    if (bmp) {
      const img = this.bmpTmpCtx.createImageData(BMP_WIDTH, BMP_HEIGHT);
      for (let i = 0; i < BMP_WIDTH * BMP_HEIGHT; i++) {
        const bit = (bmp[(i / 8) | 0]! >> (7 - (i & 7))) & 1;
        const o = i * 4;
        const v = bit ? 200 : 18;
        img.data[o] = v;
        img.data[o + 1] = bit ? 210 : 20;
        img.data[o + 2] = bit ? 230 : 28;
        img.data[o + 3] = 255;
      }
      this.bmpTmpCtx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.bmpTmp, PAD, bmpY, BMP_WIDTH * BMP_SCALE, BMP_HEIGHT * BMP_SCALE);
    }

    const status = bytes[KEY_STATUS] ?? 0;
    const data = bytes[KEY_DATA] ?? 0;
    this.root.dataset.keyStatus = String(status);
    this.root.dataset.keyData = `0x${(data & 0xff).toString(16).padStart(2, '0')}`;
    // Soft PC advances every frame while Run is on — keep the status line live.
    if (this.runner?.isSoft) this.refreshControls();
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
