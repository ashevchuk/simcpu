/**
 * Multi-channel logic analyzer bound to AnalyzerComponent sense pins.
 * Samples every armed analyzer on the circuit; the floating dialog shows
 * the device last opened via dblclick.
 */

import type { Circuit } from '../sim/Circuit.js';
import type { AnalyzerComponent, Level, NetMap } from '../sim/types.js';
import { FloatingWindow } from './FloatingWindow.js';

export type Sample = 0 | 1 | 'Z';

const MAX_SAMPLES = 4096;
const ROW_H = 28;
const LABEL_W = 56;

interface Capture {
  samples: Sample[][];
  write: number;
  count: number;
}

export class LogicAnalyzer {
  private readonly win: FloatingWindow;
  readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly statusEl: HTMLElement;
  private readonly metaNote: HTMLElement;
  private device: AnalyzerComponent | null = null;
  private readonly captures = new Map<string, Capture>();
  private onRunChange: ((running: boolean) => void) | null = null;
  /** Sample index in display order (0 … count-1), or null when unset. */
  private cursorSample: number | null = null;
  onCursorChange: (() => void) | null = null;

  constructor() {
    this.win = new FloatingWindow('Logic Analyzer', 'logic-analyzer');
    this.root = this.win.body;
    this.root.innerHTML = `
      <div class="la-toolbar">
        <button type="button" data-act="run" title="Arm sampling">Arm</button>
        <button type="button" data-act="pause">Pause</button>
        <button type="button" data-act="clear">Clear</button>
        <button type="button" data-act="export">CSV</button>
      </div>
      <div class="la-note">Wire nets into CH pins. Channel count is set when placing. Click waveform for time cursor.</div>
      <canvas class="la-canvas" width="420" height="120"></canvas>
      <div class="lab-panel-status">Place Analyzer · wire channels · Arm</div>
    `;
    this.metaNote = this.root.querySelector('.la-note')!;
    this.statusEl = this.root.querySelector('.lab-panel-status')!;
    this.canvas = this.root.querySelector('.la-canvas')!;
    this.canvas.style.width = '100%';
    this.canvas.style.minHeight = '120px';
    this.canvas.style.cursor = 'crosshair';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D context missing');
    this.ctx = ctx;

    this.root.querySelector('[data-act="run"]')!.addEventListener('click', () => this.setRunning(true));
    this.root.querySelector('[data-act="pause"]')!.addEventListener('click', () => this.setRunning(false));
    this.root.querySelector('[data-act="clear"]')!.addEventListener('click', () => this.clear());
    this.root.querySelector('[data-act="export"]')!.addEventListener('click', () => this.exportCsv());
    this.canvas.addEventListener('click', (ev) => this.onCanvasClick(ev));
  }

  get attachedDevice(): AnalyzerComponent | null {
    return this.device;
  }

  get hasCursor(): boolean {
    return this.cursorSample != null && this.device != null;
  }

  getCursorSample(): number | null {
    return this.cursorSample;
  }

  /** Levels at the time cursor for each channel of the open device. */
  getCursorLevels(): Sample[] | null {
    if (this.cursorSample == null || !this.device) return null;
    const cap = this.ensureCapture(this.device);
    if (cap.count === 0) return null;
    const s = Math.max(0, Math.min(cap.count - 1, this.cursorSample));
    const out: Sample[] = [];
    for (let ch = 0; ch < this.device.channelCount; ch++) {
      const idx = (cap.write - cap.count + s + MAX_SAMPLES) % MAX_SAMPLES;
      out.push(cap.samples[ch]![idx]!);
    }
    return out;
  }

  clearCursor(): void {
    if (this.cursorSample == null) return;
    this.cursorSample = null;
    this.draw();
    this.onCursorChange?.();
  }

  private onCanvasClick(ev: MouseEvent): void {
    if (!this.device) return;
    const cap = this.ensureCapture(this.device);
    const cssW = this.canvas.clientWidth || 420;
    const plotW = cssW - LABEL_W - 8;
    const x = ev.offsetX;
    if (cap.count === 0 || x < LABEL_W || plotW <= 0) {
      this.cursorSample = null;
    } else {
      const t = Math.max(0, Math.min(1, (x - LABEL_W) / plotW));
      this.cursorSample = Math.round(t * Math.max(0, cap.count - 1));
    }
    this.draw();
    this.onCursorChange?.();
  }

  setOnRunChange(fn: ((running: boolean) => void) | null): void {
    this.onRunChange = fn;
  }

  get isArmed(): boolean {
    return this.device?.armed === true;
  }

  /** True if any analyzer on the given circuit is armed. */
  anyArmed(circuit: Circuit): boolean {
    for (const c of circuit.components.values()) {
      if (c.kind === 'analyzer' && c.armed) return true;
    }
    return false;
  }

  setRunning(running: boolean): void {
    if (!this.device) return;
    this.device.armed = running;
    this.root.querySelector('[data-act="run"]')!.classList.toggle('active', running);
    this.statusEl.textContent = running ? 'armed — sampling' : 'paused';
    this.win.setTitle('Logic Analyzer', `${this.device.channelCount} ch${running ? ' · ARM' : ''}`);
    this.onRunChange?.(running);
  }

  attach(device: AnalyzerComponent): void {
    this.device = device;
    this.ensureCapture(device);
    this.metaNote.textContent = `${device.channelCount} channels (ch0…ch${device.channelCount - 1})`;
    this.win.setTitle('Logic Analyzer', `${device.channelCount} ch`);
    this.root.querySelector('[data-act="run"]')!.classList.toggle('active', device.armed);
    this.statusEl.textContent = device.armed ? 'armed — sampling' : 'paused';
    this.win.setVisible(true);
    this.draw();
  }

  detach(): void {
    this.device = null;
    this.win.setVisible(false);
  }

  clearChannels(): void {
    this.captures.clear();
    this.detach();
  }

  setVisible(show: boolean): void {
    this.win.setVisible(show);
  }

  private ensureCapture(device: AnalyzerComponent): Capture {
    let cap = this.captures.get(device.id);
    if (!cap || cap.samples.length !== device.channelCount) {
      cap = {
        samples: Array.from({ length: device.channelCount }, () => new Array(MAX_SAMPLES).fill('Z')),
        write: 0,
        count: 0,
      };
      this.captures.set(device.id, cap);
    }
    return cap;
  }

  clear(): void {
    if (!this.device) return;
    const cap = this.ensureCapture(this.device);
    cap.write = 0;
    cap.count = 0;
    this.cursorSample = null;
    for (const buf of cap.samples) buf.fill('Z');
    this.draw();
    this.onCursorChange?.();
  }

  /** Sample every armed analyzer on `circuit`. */
  sampleCircuit(circuit: Circuit, netMap: NetMap, levelOf: Map<string, Level>): void {
    let drew = false;
    for (const c of circuit.components.values()) {
      if (c.kind !== 'analyzer' || !c.armed) continue;
      const cap = this.ensureCapture(c);
      for (let i = 0; i < c.channelCount; i++) {
        const pin = c.pins[`ch${i}`];
        let sample: Sample = 'Z';
        if (pin) {
          const net = netMap.netOf.get(pin.id);
          if (net) {
            const lvl = levelOf.get(net);
            if (lvl === 0 || lvl === 1) sample = lvl;
          }
        }
        cap.samples[i]![cap.write] = sample;
      }
      cap.write = (cap.write + 1) % MAX_SAMPLES;
      if (cap.count < MAX_SAMPLES) cap.count++;
      if (this.device?.id === c.id) drew = true;
    }
    if (drew && this.win.visible) this.draw();
  }

  private draw(): void {
    if (!this.device) return;
    const cap = this.ensureCapture(this.device);
    const dpr = window.devicePixelRatio || 1;
    const nCh = this.device.channelCount;
    const cssW = this.canvas.clientWidth || 420;
    const cssH = Math.max(80, nCh * ROW_H + 16);
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.height = `${cssH}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const ctx = this.ctx;
    ctx.fillStyle = '#0e1016';
    ctx.fillRect(0, 0, cssW, cssH);

    if (cap.count === 0) {
      ctx.fillStyle = '#6a7184';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText('no samples', 12, 24);
      return;
    }

    const plotW = cssW - LABEL_W - 8;
    const n = cap.count;
    for (let ch = 0; ch < nCh; ch++) {
      const y0 = 8 + ch * ROW_H;
      ctx.fillStyle = '#9aa1b3';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(`ch${ch}`, 4, y0 + 14);

      const buf = cap.samples[ch]!;
      ctx.strokeStyle = '#4da3ff';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let s = 0; s < n; s++) {
        const idx = (cap.write - n + s + MAX_SAMPLES) % MAX_SAMPLES;
        const v = buf[idx]!;
        const y = v === 1 ? y0 + 4 : v === 0 ? y0 + ROW_H - 8 : y0 + ROW_H / 2;
        const x = LABEL_W + (s / Math.max(1, n - 1)) * plotW;
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    if (this.cursorSample != null && n > 0) {
      const s = Math.max(0, Math.min(n - 1, this.cursorSample));
      const x = LABEL_W + (s / Math.max(1, n - 1)) * plotW;
      ctx.strokeStyle = '#f5c518';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 4);
      ctx.lineTo(x, cssH - 4);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#f5c518';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(`t=${s}`, x + 4, 12);
    }
  }

  private exportCsv(): void {
    if (!this.device) return;
    const cap = this.ensureCapture(this.device);
    if (cap.count === 0) return;
    const labels = Array.from({ length: this.device.channelCount }, (_, i) => `ch${i}`);
    const lines = [`t,${labels.join(',')}`];
    for (let s = 0; s < cap.count; s++) {
      const cols = [String(s)];
      for (let ch = 0; ch < this.device.channelCount; ch++) {
        const idx = (cap.write - cap.count + s + MAX_SAMPLES) % MAX_SAMPLES;
        cols.push(String(cap.samples[ch]![idx]));
      }
      lines.push(cols.join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'logic-analyzer.csv';
    a.click();
    URL.revokeObjectURL(url);
  }
}
