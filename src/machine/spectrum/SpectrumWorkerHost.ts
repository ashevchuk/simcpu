/**
 * Host for Spectrum soft-run Worker with main-thread SpectrumEngine fallback.
 */

import { SpectrumEngine, type SpectrumFrameResult, type SpectrumTurbo } from './engine.js';
import type { SpectrumModel } from './mmu.js';
import type { TrdInfo } from './expansions.js';
import type { WorkerInMsg, WorkerOutMsg } from './workerProtocol.js';
import { Ay8912 } from './ay8912.js';

export type SpectrumHostFrame = SpectrumFrameResult & {
  fromWorker: boolean;
};

export type SpectrumSnapshotBundle = {
  sna: Uint8Array;
  z80: Uint8Array;
  scr: Uint8Array;
};

/**
 * Prefer a dedicated Worker (`spectrum-worker.js` next to the page). Fall back
 * to an in-page SpectrumEngine when Workers are unavailable (some file:// cases).
 */
export class SpectrumWorkerHost {
  private worker: Worker | null = null;
  /** Always kept for UI sync / fallback ticks. */
  readonly engine = new SpectrumEngine();
  private useWorker = false;
  private pendingFrame: SpectrumHostFrame | null = null;
  private lastRgba: Uint8Array | null = null;
  /** Last 64-byte watch dump from worker (UI hex). */
  lastWatchBytes: Uint8Array | null = null;
  /** Soft-error string from the live engine (Worker frame or main tick). */
  lastSoftError: string | null = null;
  onError: ((msg: string) => void) | null = null;
  private pendingSnapshot:
    | {
        resolve: (v: SpectrumSnapshotBundle) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | null = null;

  /** Try to start Worker; returns true if Worker path is active. */
  start(): boolean {
    if (this.worker) return this.useWorker;
    try {
      const url = new URL('spectrum-worker.js', location.href);
      this.worker = new Worker(url.href);
      this.worker.onmessage = (ev: MessageEvent<WorkerOutMsg>) => this.onWorkerMsg(ev.data);
      this.worker.onerror = () => {
        // Worker may fail to parse/load (vite URL, file://). Fall back to main
        // thread without stamping a sticky softError on the machine panel.
        this.fallbackToMain();
      };
      this.useWorker = true;
      return true;
    } catch {
      this.fallbackToMain();
      return false;
    }
  }

  get usingWorker(): boolean {
    return this.useWorker && this.worker != null;
  }

  /** Last RGBA frame (Worker) or null when only main-thread blit is used. */
  get lastFrameRgba(): Uint8Array | null {
    return this.lastRgba;
  }

  private fallbackToMain(): void {
    this.useWorker = false;
    if (this.pendingSnapshot) {
      this.pendingSnapshot.reject(new Error('Spectrum worker stopped'));
      clearTimeout(this.pendingSnapshot.timer);
      this.pendingSnapshot = null;
    }
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        /* ignore */
      }
      this.worker = null;
    }
  }

  stop(): void {
    this.fallbackToMain();
  }

  /** Exposed for unit tests / diagnostics. */
  postForTest(msg: WorkerInMsg, transfer?: Transferable[]): void {
    this.post(msg, transfer);
  }

  private post(msg: WorkerInMsg, transfer?: Transferable[]): void {
    if (this.worker && this.useWorker) {
      this.worker.postMessage(msg, transfer ?? []);
    }
  }

  private onWorkerMsg(msg: WorkerOutMsg): void {
    if (msg.type === 'error') {
      this.lastSoftError = msg.message;
      this.onError?.(msg.message);
      if (this.pendingSnapshot) {
        this.pendingSnapshot.reject(new Error(msg.message));
        clearTimeout(this.pendingSnapshot.timer);
        this.pendingSnapshot = null;
      }
      return;
    }
    if (msg.type === 'snapshot') {
      if (this.pendingSnapshot) {
        clearTimeout(this.pendingSnapshot.timer);
        this.pendingSnapshot.resolve({
          sna: new Uint8Array(msg.sna),
          z80: new Uint8Array(msg.z80),
          scr: new Uint8Array(msg.scr),
        });
        this.pendingSnapshot = null;
      }
      return;
    }
    if (msg.type === 'frame') {
      const rgba = msg.rgba ? new Uint8Array(msg.rgba) : this.lastRgba;
      if (rgba) this.lastRgba = rgba;
      const cpu = this.engine.cpu;
      cpu.pc = msg.pc;
      cpu.sp = msg.sp;
      cpu.a = msg.a;
      cpu.f = msg.f;
      cpu.b = msg.b;
      cpu.c = msg.c;
      cpu.d = msg.d;
      cpu.e = msg.e;
      cpu.h = msg.h;
      cpu.l = msg.l;
      cpu.ix = msg.ix;
      cpu.iy = msg.iy;
      cpu.i = msg.i;
      cpu.r = msg.r;
      cpu.im = msg.im;
      cpu.iff1 = msg.iff1;
      cpu.iff2 = msg.iff2;
      cpu.halted = msg.halted;
      this.engine.running = msg.running;
      this.engine.breakpointHit = msg.breakpointHit;
      this.engine.breakWriteHit = msg.breakWriteHit;
      this.engine.mmu.port7ffd = msg.port7ffd;
      this.engine.mmu.trdosPaged = msg.trdosPaged;
      this.engine.contended.waitUnits = msg.contendedWaits;
      this.engine.contended.hits = msg.contendedHits;
      this.engine.ay.loadRegs(new Uint8Array(msg.ayRegs), msg.aySelected);
      this.engine.watchAddr = msg.watchAddr;
      this.lastWatchBytes = new Uint8Array(msg.watchBytes);
      this.engine.ula.border = msg.border & 7;
      this.lastSoftError = msg.softError;
      if (msg.softError) this.engine.softError = msg.softError;
      // Keep main-thread tape browser in sync with Worker flash-load progress
      if (this.engine.tape && typeof msg.tapePos === 'number') {
        this.engine.tape.seek(msg.tapePos);
      }
      this.pendingFrame = {
        rgba: rgba ?? new Uint8Array(0),
        beeper: { startEar: msg.beeperStart, transitions: msg.beeperTransitions },
        ayRegs: new Uint8Array(msg.ayRegs),
        aySelected: msg.aySelected,
        tStates: msg.tStates,
        breakpointHit: msg.breakpointHit,
        breakWriteHit: msg.breakWriteHit,
        running: msg.running,
        tapePos: msg.tapePos,
        tapeBlocks: msg.tapeBlocks,
        contendedWaits: msg.contendedWaits,
        contendedHits: msg.contendedHits,
        fromWorker: true,
      };
    }
  }

  boot(model: SpectrumModel): void {
    this.engine.boot(model);
    this.lastSoftError = null;
    this.post({ type: 'boot', model });
  }

  bootTrdos(): void {
    this.engine.bootTrdos();
    this.post({ type: 'bootTrdos' });
  }

  setRunning(on: boolean): void {
    this.engine.running = on;
    this.post({ type: 'setRunning', on });
  }

  setTurbo(t: SpectrumTurbo): void {
    this.engine.setTurbo(t);
    this.post({ type: 'setTurbo', turbo: t });
  }

  setBreakpointPc(pc: number | null): void {
    this.engine.setBreakpointPc(pc);
    this.post({ type: 'setBreakpointPc', pc });
  }

  setBreakWriteAddr(addr: number | null): void {
    this.engine.setBreakWriteAddr(addr);
    this.post({ type: 'setBreakWriteAddr', addr });
  }

  poke(addr: number, val: number): void {
    this.engine.poke(addr, val);
    this.post({ type: 'poke', addr, val });
  }

  setKey(label: string, down: boolean): void {
    this.engine.setKey(label, down);
    this.post({ type: 'setKey', label, down });
  }

  clearKeys(): void {
    this.engine.ula.clearKeys();
    this.post({ type: 'clearKeys' });
  }

  setWatchAddr(addr: number): void {
    this.engine.watchAddr = addr & 0xffff;
    this.post({ type: 'setWatchAddr', addr: addr & 0xffff });
  }

  setKempston(bit: 0 | 1 | 2 | 3 | 4, down: boolean): void {
    this.engine.setKempston(bit, down);
    this.post({ type: 'setKempston', bit, down });
  }

  step(): void {
    if (this.usingWorker) this.post({ type: 'step' });
    else this.engine.step();
  }

  stepOver(): void {
    if (this.usingWorker) this.post({ type: 'stepOver' });
    else this.engine.stepOver();
  }

  nmi(): void {
    if (this.usingWorker) this.post({ type: 'nmi' });
    else this.engine.nmi();
  }

  rewindTape(): void {
    this.engine.tape?.reset();
    this.post({ type: 'rewindTape' });
  }

  advanceTape(): void {
    this.engine.tape?.next();
    this.post({ type: 'advanceTape' });
  }

  seekTape(index: number): void {
    this.engine.tape?.seek(index);
    this.post({ type: 'seekTape', index });
  }

  setTapePaused(on: boolean): void {
    this.engine.tapePaused = on;
    this.post({ type: 'setTapePaused', on });
  }

  setTapeAutoStop(on: boolean): void {
    this.engine.tapeAutoStop = on;
    this.post({ type: 'setTapeAutoStop', on });
  }

  enqueueTape(item: { name: string; kind: 'tap' | 'tzx'; data: Uint8Array }): void {
    this.engine.enqueueTape(item);
    const buf = item.data.buffer.slice(
      item.data.byteOffset,
      item.data.byteOffset + item.data.byteLength,
    ) as ArrayBuffer;
    this.post({ type: 'enqueueTape', name: item.name, kind: item.kind, data: buf }, [buf]);
  }

  clearTapeQueue(): void {
    this.engine.clearTapeQueue();
    this.post({ type: 'clearTapeQueue' });
  }

  /**
   * Drive one frame. Worker path posts async; returns last completed frame or
   * sync engine result. Caller should play audio from the returned frame.
   */
  tick(wantRgba: boolean): SpectrumHostFrame | null {
    if (this.usingWorker) {
      this.post({ type: 'tick', wantRgba });
      const f = this.pendingFrame;
      this.pendingFrame = null;
      return f;
    }
    const r = this.engine.tickFrame(wantRgba);
    this.lastSoftError = this.engine.softError;
    if (wantRgba && r.rgba.length) this.lastRgba = r.rgba;
    return { ...r, fromWorker: false };
  }

  mountTap(data: Uint8Array, cold = false) {
    const r = this.engine.mountTap(data, cold);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    this.post({ type: 'mountTap', data: buf, cold }, [buf]);
    return r;
  }

  mountTzx(data: Uint8Array, cold = false) {
    const r = this.engine.mountTzx(data, cold);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    this.post({ type: 'mountTzx', data: buf, cold }, [buf]);
    return r;
  }

  mountTrd(data: Uint8Array): TrdInfo {
    const trd = this.engine.mountTrd(data);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    this.post({ type: 'mountTrd', data: buf }, [buf]);
    return trd;
  }

  loadSna(data: Uint8Array) {
    const r = this.engine.loadSna(data);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    this.post({ type: 'loadSna', data: buf }, [buf]);
    return r;
  }

  loadZ80(data: Uint8Array) {
    const r = this.engine.loadZ80(data);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    this.post({ type: 'loadZ80', data: buf }, [buf]);
    return r;
  }

  loadScr(data: Uint8Array): void {
    this.engine.loadScr(data);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    this.post({ type: 'loadScr', data: buf }, [buf]);
  }

  setRom48Basic(on: boolean): void {
    this.engine.setRom48Basic(on);
    this.post({ type: 'setRom48Basic', on });
  }

  /** Snapshot from the live engine (Worker when active). */
  async getSnapshot(timeoutMs = 5_000): Promise<SpectrumSnapshotBundle> {
    if (!this.usingWorker) {
      return {
        sna: this.engine.saveSna(),
        z80: this.engine.saveZ80(),
        scr: this.engine.saveScr(),
      };
    }
    if (this.pendingSnapshot) {
      clearTimeout(this.pendingSnapshot.timer);
      this.pendingSnapshot.reject(new Error('Superseded snapshot request'));
      this.pendingSnapshot = null;
    }
    return new Promise<SpectrumSnapshotBundle>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingSnapshot) {
          this.pendingSnapshot = null;
          reject(new Error('Spectrum snapshot timeout'));
        }
      }, timeoutMs);
      this.pendingSnapshot = { resolve, reject, timer };
      this.post({ type: 'getSnapshot' });
    });
  }

  /** Apply worker AY regs onto a main-thread chip for audio (optional). */
  syncAyTo(chip: Ay8912): void {
    chip.loadRegs(this.engine.ay.regs, this.engine.ay.selected);
  }
}
