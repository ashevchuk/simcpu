import type { ChipLibrary } from '../sim/ChipLibrary.js';
import type { Circuit } from '../sim/Circuit.js';
import type { Z80Cpu } from '../sim/blocks.js';
import { makeInput, makeLabel, wire } from '../sim/library.js';
import type { InputComponent, Pin, RamComponent } from '../sim/types.js';
import { createSoftDevices, type SoftDevices } from './softDevices.js';
import { createSoftZ80, softRun, softStep, type SoftMemHooks, type SoftZ80State } from './softZ80.js';
import { softIoLayoutForAddrBits } from './memoryMap.js';
import { SpectrumUla } from './spectrum/ula.js';
import { isSna128 } from './spectrum/sna.js';
import { peekZ80Model } from './spectrum/z80snap.js';
import type { SpectrumTape } from './spectrum/tap.js';
import { SCR_SIZE } from './spectrum/scr.js';
import { SpectrumMmu, type SpectrumModel } from './spectrum/mmu.js';
import { AyAudio } from './spectrum/ay8912.js';
import { ContendedStub, ExpansionStub, type TrdInfo } from './spectrum/expansions.js';
import { SpectrumWorkerHost } from './spectrum/SpectrumWorkerHost.js';
import {
  SPECTRUM_OPS_PER_FRAME as ENGINE_OPS,
  type SpectrumTurbo as EngineTurbo,
} from './spectrum/engine.js';

type TickFn = () => void;

/**
 * Connect two pins via same-named local labels (short stubs) instead of a
 * drawn point-to-point wire — keeps the top-level canvas readable after
 * the Z80 folds into one chip while Inputs stay outside.
 */
function tieByLabel(circuit: Circuit, name: string, a: Pin, b: Pin): void {
  const la = makeLabel(circuit, name, { x: a.pos.x + 8, y: a.pos.y });
  wire(circuit, a, la.pins.net);
  const lb = makeLabel(circuit, name, { x: b.pos.x + 8, y: b.pos.y });
  wire(circuit, b, lb.pins.net);
}

/**
 * Run modes:
 * - soft: behavioral interpreter on ram.bytes (default — usable TTY)
 * - slow/normal/turbo/free: transistor MachineRunner with a per-frame time budget
 */
export type RunSpeed = 'soft' | 'slow' | 'normal' | 'turbo' | 'free';

/** Soft interpreter instructions per animation frame (generic / CP/M). */
export const SOFT_OPS_PER_FRAME = 8000;

/** Soft ops/frame for Spectrum (BASIC boot needs more throughput). */
export const SPECTRUM_OPS_PER_FRAME = ENGINE_OPS;

/** Soft Spectrum speed multipliers (ops/frame = SPECTRUM_OPS_PER_FRAME * mult). */
export type SpectrumTurbo = EngineTurbo;

/** Max wall-clock ms of gate-level phases per animation frame. */
export const GATE_BUDGET_MS = 12;

/** Wider wall-clock budget for free-running gate speed (one frame may burn more CPU). */
export const FREE_BUDGET_MS = 50;

/** Cap on FSM phases per frame when using gate speeds (time budget usually hits first). */
export const PHASES_PER_FRAME: Record<Exclude<RunSpeed, 'soft'>, number> = {
  slow: 2,
  normal: 10,
  turbo: 40,
  free: 400,
};

/**
 * Soft auto-clock / soft interpreter for a placed Z80CPU.
 * Gate path wires Input drivers like the test harness; soft path runs
 * softZ80 against the shared RamComponent.bytes.
 */
export class MachineRunner {
  private circuit: Circuit | null = null;
  private cpu: Z80Cpu | null = null;
  private ram: RamComponent | null = null;
  private tick: TickFn | null = null;
  private inputIds: string[] = [];
  private reset!: InputComponent;
  private aReset!: InputComponent;
  private dataClk!: InputComponent;
  private phaseClk!: InputComponent;
  private fsmLoad!: InputComponent;
  private seedWes: InputComponent[] = [];
  private booted = false;
  private soft: SoftZ80State | null = null;
  private devices: SoftDevices = createSoftDevices();
  /** Soft ZX Spectrum ULA — when set, softHooks use FE + IRQ (+ 7FFD via MMU). */
  spectrum: SpectrumUla | null = null;
  /** Soft Spectrum memory map (48 or 128). */
  spectrumMmu: SpectrumMmu | null = null;
  /** Mounted .TAP/.TZX for LD-BYTES flash-load (Spectrum mode). */
  spectrumTape: SpectrumTape | null = null;
  /** Soft contended-access counter + wait budget. */
  get contended(): ContendedStub {
    return this.spectrumHost?.engine.contended ?? this._contended;
  }
  private readonly _contended = new ContendedStub();
  /** +2A / DivMMC port stubs. */
  get expansion(): ExpansionStub {
    return this.spectrumHost?.engine.expansion ?? this._expansion;
  }
  private readonly _expansion = new ExpansionStub();
  /** Mounted .TRD image. */
  get trdDisk(): TrdInfo | null {
    return this.spectrumHost?.engine.trdDisk ?? this._trdDisk;
  }
  private _trdDisk: TrdInfo | null = null;
  /** Soft PC breakpoint — freeze Run when PC matches (null = off). */
  get breakpointPc(): number | null {
    return this.spectrumHost?.engine.breakpointPc ?? this._breakpointPc;
  }
  private _breakpointPc: number | null = null;
  /** Set when breakpoint fired this tick. */
  get breakpointHit(): boolean {
    return this.spectrumHost?.engine.breakpointHit ?? this._breakpointHit;
  }
  set breakpointHit(v: boolean) {
    if (this.spectrumHost) this.spectrumHost.engine.breakpointHit = v;
    this._breakpointHit = v;
  }
  private _breakpointHit = false;
  /** Break-on-write address. */
  get breakWriteAddr(): number | null {
    return this.spectrumHost?.engine.breakWriteAddr ?? null;
  }
  /** Spectrum engine + optional Worker host. */
  spectrumHost: SpectrumWorkerHost | null = null;
  /** Last transferable RGBA from worker/engine (for blit). */
  lastSpectrumRgba: Uint8Array | null = null;
  /** AY + Web Audio (created lazily on first Spectrum frame with sound). */
  readonly ayAudio = new AyAudio();
  /** Soft Spectrum speed multiplier. */
  spectrumTurbo: SpectrumTurbo = 1;
  /** Draw every Nth frame when turbo > 1 (1 = every frame). */
  spectrumFrameSkip = 1;
  private spectrumFrameCounter = 0;
  /** Gate FSM seed deferred while Soft is the active speed. */
  private gateBootPending = false;
  /** True after soft Run has diverged from gate-level PC/regs. */
  softDesynced = false;
  /** Last soft interpreter error (cleared on reboot/boot). */
  softError: string | null = null;
  running = false;
  speed: RunSpeed = 'soft';
  /** Optional gate-level pin reader (from last settle) for halt detection. */
  private readPin: ((pin: Pin) => 0 | 1 | 'Z') | null = null;

  get attached(): boolean {
    return this.circuit !== null && this.cpu !== null;
  }

  /** Machine RAM when attached (for I/O map / soft console). */
  get machineRam(): RamComponent | null {
    return this.ram;
  }

  /** Soft CPU when attached (Spectrum engine CPU when in Spectrum mode). */
  get softCpu(): SoftZ80State | null {
    return this.spectrumHost?.engine.cpu ?? this.soft;
  }

  get softDevices(): SoftDevices {
    return this.devices;
  }

  get isSpectrum(): boolean {
    return this.spectrum !== null && this.spectrumMmu !== null;
  }

  get spectrumModel(): SpectrumModel | null {
    return this.spectrumMmu?.model ?? null;
  }

  /** Enter or leave soft Spectrum mode (clears CP/M host traps when enabling). */
  setSpectrumMode(on: boolean, model: SpectrumModel = '48'): void {
    if (on) {
      if (!this.spectrumHost) {
        this.spectrumHost = new SpectrumWorkerHost();
        this.spectrumHost.start();
        this.spectrumHost.onError = (m) => {
          this.softError = m;
        };
      }
      this.spectrumHost.boot(model);
      this.spectrum = this.spectrumHost.engine.ula;
      this.spectrumMmu = this.spectrumHost.engine.mmu;
      this.soft = this.spectrumHost.engine.cpu;
      this.spectrumTape = this.spectrumHost.engine.tape;
      this.devices.cpm = null;
      this.devices.realCpm = false;
      void this.ayAudio.ensure();
    } else {
      this.spectrumHost?.stop();
      this.spectrumHost = null;
      this.spectrum = null;
      this.spectrumMmu = null;
      this.spectrumTape = null;
      this._trdDisk = null;
      this._breakpointPc = null;
      this._breakpointHit = false;
      this._contended.reset();
      this._expansion.reset();
      this.lastSpectrumRgba = null;
      this.ayAudio.reset();
    }
  }

  /** Ensure Spectrum mode + ROM + soft CPU; does not clear RAM banks unless mode changes. */
  ensureSpectrumSoft(model: SpectrumModel = '48'): void {
    if (!this.ram || this.ram.bytes.length < 0x10000) {
      throw new Error('Spectrum needs 64K RAM (addrBits=16)');
    }
    const needNew =
      !this.spectrumHost ||
      !this.spectrum ||
      !this.spectrumMmu ||
      this.spectrumMmu.model !== model;
    if (needNew) {
      this.setSpectrumMode(true, model);
    }
    if (!this.booted || !this.soft) {
      this.booted = false;
      this.boot();
    }
    if (this.spectrumHost) {
      this.soft = this.spectrumHost.engine.cpu;
      this.spectrum = this.spectrumHost.engine.ula;
      this.spectrumMmu = this.spectrumHost.engine.mmu;
      this.spectrumTape = this.spectrumHost.engine.tape;
    } else if (!this.soft) {
      this.soft = createSoftZ80(this.softStackTop());
    }
  }

  /** Load a 48K or 128K .SNA snapshot and start soft Run. */
  loadSpectrumSna(data: Uint8Array): {
    pc: number;
    border: number;
    model: SpectrumModel;
    port7ffd: number;
  } {
    this.ensureSpectrumSoft(isSna128(data) ? '128' : '48');
    const result = this.spectrumHost!.loadSna(data);
    this.soft = this.spectrumHost!.engine.cpu;
    this.spectrum = this.spectrumHost!.engine.ula;
    this.spectrumMmu = this.spectrumHost!.engine.mmu;
    this.softDesynced = true;
    this.softError = null;
    this.running = true;
    this.spectrumHost!.setRunning(true);
    void this.ayAudio.ensure();
    return result;
  }

  /** Load a .Z80 snapshot (v1/v2/v3) and start soft Run. */
  loadSpectrumZ80(data: Uint8Array): {
    pc: number;
    border: number;
    model: SpectrumModel;
    port7ffd: number;
    version: 1 | 2 | 3;
  } {
    const model = peekZ80Model(data);
    this.ensureSpectrumSoft(model);
    const result = this.spectrumHost!.loadZ80(data);
    this.soft = this.spectrumHost!.engine.cpu;
    this.spectrum = this.spectrumHost!.engine.ula;
    this.spectrumMmu = this.spectrumHost!.engine.mmu;
    this.ayAudio.chip.loadRegs(this.spectrumHost!.engine.ay.regs, this.spectrumHost!.engine.ay.selected);
    this.softDesynced = true;
    this.softError = null;
    this.running = true;
    this.spectrumHost!.setRunning(true);
    void this.ayAudio.ensure();
    return result;
  }

  /** Serialize current Spectrum state as .SNA bytes (live Worker when active). */
  async saveSpectrumSna(): Promise<Uint8Array> {
    if (!this.spectrumHost) throw new Error('No Spectrum machine to save');
    const snap = await this.spectrumHost.getSnapshot();
    return snap.sna;
  }

  /** Serialize current Spectrum state as .Z80 v3 bytes (includes AY). */
  async saveSpectrumZ80(): Promise<Uint8Array> {
    if (!this.spectrumHost) throw new Error('No Spectrum machine to save');
    const snap = await this.spectrumHost.getSnapshot();
    return snap.z80;
  }

  setSpectrumTurbo(t: SpectrumTurbo): void {
    this.spectrumTurbo = t;
    this.spectrumFrameSkip = t >= 8 ? 3 : t >= 4 ? 2 : 1;
    this.spectrumHost?.setTurbo(t);
  }

  /** True if the UI should redraw the Spectrum screen this animation frame. */
  shouldDrawSpectrumFrame(): boolean {
    if (!this.isSpectrum) return true;
    return this.spectrumFrameCounter % Math.max(1, this.spectrumFrameSkip) === 0;
  }

  /** Mount a .TAP for BASIC `LOAD ""` (flash-load via LD-BYTES trap). */
  mountSpectrumTap(data: Uint8Array): { blocks: number; cold: boolean } {
    const cold = this.spectrum === null || !this.soft || !this.spectrumMmu;
    this.ensureSpectrumSoft(this.spectrumMmu?.model ?? '48');
    const result = this.spectrumHost!.mountTap(data, cold);
    this.spectrumTape = this.spectrumHost!.engine.tape;
    this.soft = this.spectrumHost!.engine.cpu;
    this.softDesynced = true;
    this.softError = null;
    this.running = true;
    this.spectrumHost!.setRunning(true);
    return result;
  }

  /** Mount a .TZX (standard/turbo data blocks) for flash-load. */
  mountSpectrumTzx(data: Uint8Array): { blocks: number; cold: boolean; warnings: string[] } {
    const cold = this.spectrum === null || !this.soft || !this.spectrumMmu;
    this.ensureSpectrumSoft(this.spectrumMmu?.model ?? '48');
    const result = this.spectrumHost!.mountTzx(data, cold);
    this.spectrumTape = this.spectrumHost!.engine.tape;
    this.soft = this.spectrumHost!.engine.cpu;
    this.softDesynced = true;
    this.softError = null;
    this.running = true;
    this.spectrumHost!.setRunning(true);
    return result;
  }

  /** Rewind mounted tape to block 0. */
  rewindSpectrumTape(): void {
    this.spectrumHost?.rewindTape();
    this.spectrumTape = this.spectrumHost?.engine.tape ?? null;
  }

  /** Advance tape position by one block (manual browser). */
  advanceSpectrumTape(): void {
    this.spectrumHost?.advanceTape();
  }

  /** Seek tape to a block index. */
  seekSpectrumTape(index: number): void {
    this.spectrumHost?.seekTape(index);
  }

  get spectrumTapePos(): number {
    return this.spectrumHost?.engine.tape?.pos ?? this.spectrumTape?.pos ?? 0;
  }

  get spectrumTapeBlocks(): { flag: number; length: number }[] {
    const t = this.spectrumHost?.engine.tape ?? this.spectrumTape;
    if (!t) return [];
    return t.blocks.map((b) => ({ flag: b.flag, length: b.data.length }));
  }

  setTapePaused(on: boolean): void {
    this.spectrumHost?.setTapePaused(on);
  }

  get tapePaused(): boolean {
    return this.spectrumHost?.engine.tapePaused ?? false;
  }

  setTapeAutoStop(on: boolean): void {
    this.spectrumHost?.setTapeAutoStop(on);
  }

  enqueueSpectrumTape(name: string, kind: 'tap' | 'tzx', data: Uint8Array): void {
    this.spectrumHost?.enqueueTape({ name, kind, data });
  }

  clearSpectrumTapeQueue(): void {
    this.spectrumHost?.clearTapeQueue();
  }

  get spectrumTapeQueueLength(): number {
    return this.spectrumHost?.engine.tapeQueue.length ?? 0;
  }

  /** Save visible display file as .SCR (6912 bytes). */
  async saveSpectrumScr(): Promise<Uint8Array> {
    if (!this.spectrumHost) throw new Error('No Spectrum machine to save');
    const snap = await this.spectrumHost.getSnapshot();
    return snap.scr;
  }

  /** Load .SCR into visible display bank. */
  loadSpectrumScr(data: Uint8Array): void {
    this.ensureSpectrumSoft(this.spectrumMmu?.model ?? '48');
    this.spectrumHost!.loadScr(data);
    this.softDesynced = true;
  }

  /** Mount a .TRD image (Beta Disk sector I/O). */
  mountSpectrumTrd(data: Uint8Array): TrdInfo {
    this.ensureSpectrumSoft(this.spectrumMmu?.model ?? '128');
    const trd = this.spectrumHost!.mountTrd(data);
    this._trdDisk = trd;
    return trd;
  }

  /** Boot TR-DOS ROM at $0000. */
  bootSpectrumTrdos(): void {
    this.ensureSpectrumSoft(this.spectrumMmu?.model ?? '128');
    this.spectrumHost!.bootTrdos();
    this.soft = this.spectrumHost!.engine.cpu;
    this.spectrumMmu = this.spectrumHost!.engine.mmu;
    this.running = true;
    this.spectrumHost!.setRunning(true);
  }

  /** 128K: switch to 48 BASIC ROM (bit4) or editor. */
  setSpectrumRom48Basic(on: boolean): void {
    this.spectrumHost?.setRom48Basic(on);
  }

  setBreakpointPc(pc: number | null): void {
    this._breakpointPc = pc == null ? null : pc & 0xffff;
    this._breakpointHit = false;
    this.spectrumHost?.setBreakpointPc(pc);
  }

  setBreakWriteAddr(addr: number | null): void {
    this.spectrumHost?.setBreakWriteAddr(addr);
  }

  pokeSpectrum(addr: number, val: number): void {
    this.ensureSpectrumSoft(this.spectrumMmu?.model ?? '48');
    this.spectrumHost!.poke(addr, val);
  }

  stepSpectrumOver(): void {
    this.spectrumHost?.stepOver();
    if (this.spectrumHost) this.soft = this.spectrumHost.engine.cpu;
  }

  /** Soft NMI → $0066. */
  pulseSpectrumNmi(): void {
    if (!this.spectrumHost) throw new Error('No soft CPU');
    this.spectrumHost.nmi();
    this.soft = this.spectrumHost.engine.cpu;
    this.softDesynced = true;
  }

  get scrSize(): number {
    return SCR_SIZE;
  }

  private softHooks(): SoftMemHooks {
    if (this.spectrumHost && this.spectrum && this.spectrumMmu) {
      return this.spectrumHost.engine.hooks();
    }
    const ram = this.ram!;
    const dev = this.devices;
    const layout = softIoLayoutForAddrBits(ram.addrBits);
    return {
      clearOnReadKeys: true,
      addrBits: layout.addrBits,
      keyDataAddr: layout.keyData,
      keyStatusAddr: layout.keyStatus,
      portIn: (port) => dev.portIn(ram.bytes, port),
      portOut: (port, val) => dev.portOut(ram.bytes, port, val),
      portInBlock: (port) => ((port & 0xff) === 0x01 ? dev.coninWouldBlock() : false),
      hostTrap: (cpu, bytes) => {
        const cpm = dev.cpm;
        if (!cpm) return false;
        return cpm.handleTrap(cpu, bytes, dev);
      },
    };
  }

  private softStackTop(): number {
    if (this.spectrum) return 0xffff;
    return softIoLayoutForAddrBits(this.ram?.addrBits ?? 12).stackTop;
  }

  get isSoft(): boolean {
    return this.speed === 'soft';
  }

  get phasesPerFrame(): number {
    if (this.speed === 'soft') {
      if (this.spectrum) {
        return Math.max(1000, Math.floor(SPECTRUM_OPS_PER_FRAME * this.spectrumTurbo));
      }
      return SOFT_OPS_PER_FRAME;
    }
    return PHASES_PER_FRAME[this.speed];
  }

  setSpeed(speed: RunSpeed): void {
    const prev = this.speed;
    this.speed = speed;
    // Soft attach defers transistor boot — complete it the first time Gates is selected.
    if (prev === 'soft' && speed !== 'soft' && this.gateBootPending) {
      this.gateBootPending = false;
      this.booted = false;
      this.boot();
    }
  }

  /**
   * Wire clocks/reset/FSM seed/lean register zero-seeds beside the CPU.
   * Call `boot()` once afterward before Run/Step.
   *
   * Inputs sit in a compact grid next to RAM (not thousands of units away).
   * Connections use net labels so the post-fold top view does not grow a
   * "noodle" of Input→chip-port wires across the canvas.
   */
  attach(
    circuit: Circuit,
    _library: ChipLibrary,
    cpu: Z80Cpu,
    tick: TickFn,
    opts?: { readPin?: (pin: Pin) => 0 | 1 | 'Z' },
  ): void {
    this.detach();
    this.circuit = circuit;
    this.cpu = cpu;
    this.ram = cpu.ram;
    this.tick = tick;
    this.readPin = opts?.readPin ?? null;

    // Beside RAM / the eventual folded chip — old `y - 12000` parked seeds
    // far above the sprawling flat composite and became the visible spaghetti
    // once everything folded into one Z80CPU box.
    const base = { x: cpu.ram.pos.x - 360, y: cpu.ram.pos.y - 40 };
    let row = 0;
    const place = (value: 0 | 1): InputComponent => {
      const inp = makeInput(circuit, value, {
        x: base.x + (row % 6) * 44,
        y: base.y + Math.floor(row / 6) * 32,
      });
      row++;
      this.inputIds.push(inp.id);
      return inp;
    };
    let tieN = 0;
    const tie = (inp: InputComponent, pin: Pin, hint: string) => {
      tieByLabel(circuit, `RUN_${hint}_${tieN++}`, inp.pins.out, pin);
    };

    this.reset = place(1);
    tie(this.reset, cpu.reset, 'RESET');
    this.aReset = place(1);
    tie(this.aReset, cpu.aReset, 'ARESET');
    this.dataClk = place(0);
    tie(this.dataClk, cpu.clk, 'CLK');
    this.phaseClk = place(0);
    tie(this.phaseClk, cpu.phaseClk, 'PCLK');
    this.fsmLoad = place(1);
    tie(this.fsmLoad, cpu.fsmLoad, 'FSMLOAD');
    for (let i = 0; i < cpu.fsmD.length; i++) {
      const d = place(i === 0 ? 1 : 0);
      tie(d, cpu.fsmD[i]!, `FSMD${i}`);
    }

    this.seedWes = [];
    const seedReg = (reg: { we: Pin; d: Pin[] }, tag: string, width = 8) => {
      const we = place(1);
      tie(we, reg.we, `${tag}_WE`);
      this.seedWes.push(we);
      for (let i = 0; i < width; i++) {
        const bit = place(0);
        tie(bit, reg.d[i]!, `${tag}${i}`);
      }
    };

    seedReg(cpu.rB, 'B');
    seedReg(cpu.rC, 'C');
    seedReg(cpu.rD, 'D');
    seedReg(cpu.rE, 'E');
    seedReg(cpu.rH, 'H');
    seedReg(cpu.rL, 'L');
    seedReg(cpu.sp, 'SP', cpu.sp.d.length);

    this.booted = false;
    this.running = false;
    this.soft = null;
    this.devices = createSoftDevices();
    this.spectrum = null;
    this.spectrumMmu = null;
    this.spectrumTape = null;
    this.softDesynced = false;
    this.softError = null;
    this.gateBootPending = false;
  }

  detach(): void {
    this.running = false;
    this.booted = false;
    this.soft = null;
    this.devices = createSoftDevices();
    this.spectrum = null;
    this.spectrumMmu = null;
    this.spectrumTape = null;
    this.spectrumHost?.stop();
    this.spectrumHost = null;
    this.softDesynced = false;
    this.softError = null;
    this.gateBootPending = false;
    if (this.circuit) {
      for (const id of this.inputIds) this.circuit.removeComponent(id);
    }
    this.inputIds = [];
    this.seedWes = [];
    this.circuit = null;
    this.cpu = null;
    this.ram = null;
    this.tick = null;
    this.readPin = null;
  }

  /** Gate-level boot (FSM seed, reset, first fetch) + soft CPU reset. */
  boot(): void {
    if (!this.tick || !this.cpu || this.booted) return;

      // Soft is the interactive default — skip multi-second flatten/step pulses
    // until the user actually selects a Gates speed (see setSpeed).
    if (this.isSoft) {
      this.booted = true;
      this.soft = createSoftZ80(this.softStackTop());
      // Keep SoftDisks + SoftCpm / realCpm across reboot so CP/M files survive.
      const prevDisks = this.devices?.disks;
      const prevCpm = this.devices?.cpm ?? null;
      const prevReal = this.devices?.realCpm ?? false;
      this.devices = createSoftDevices(prevDisks?.[0]);
      if (prevDisks) {
        for (let i = 1; i < prevDisks.length; i++) {
          if (prevDisks[i]) this.devices.setDrive(i, prevDisks[i]!);
        }
      }
      this.devices.cpm = prevCpm;
      this.devices.realCpm = prevReal;
      this.softDesynced = false;
      this.softError = null;
      this.gateBootPending = true;
      return;
    }

    const tick = this.tick;
    const pulse = (sig: InputComponent) => {
      sig.value = 1;
      tick();
      sig.value = 0;
      tick();
    };

    tick();
    pulse(this.phaseClk);
    this.fsmLoad.value = 0;
    pulse(this.dataClk);
    this.reset.value = 0;
    this.aReset.value = 0;
    for (const we of this.seedWes) we.value = 0;
    pulse(this.dataClk);
    this.booted = true;
    this.soft = createSoftZ80(this.softStackTop());
    const prevDisks = this.devices?.disks;
    const prevCpm = this.devices?.cpm ?? null;
    const prevReal = this.devices?.realCpm ?? false;
    this.devices = createSoftDevices(prevDisks?.[0]);
    if (prevDisks) {
      for (let i = 1; i < prevDisks.length; i++) {
        if (prevDisks[i]) this.devices.setDrive(i, prevDisks[i]!);
      }
    }
    this.devices.cpm = prevCpm;
    this.devices.realCpm = prevReal;
    this.softDesynced = false;
    this.softError = null;
    this.gateBootPending = false;
  }

  /**
   * Soft/gate cold start. When Spectrum is active, reboots the Spectrum
   * engine (ROM @0000, clear tape/AY/beta) instead of creating an orphan
   * SoftZ80 that tickBudget would discard.
   */
  reboot(): void {
    const wasRunning = this.running;
    this.running = false;

    if (this.spectrumHost) {
      const model = this.spectrumMmu?.model ?? this.spectrumHost.engine.mmu.model ?? '48';
      this.spectrumHost.boot(model);
      this.soft = this.spectrumHost.engine.cpu;
      this.spectrum = this.spectrumHost.engine.ula;
      this.spectrumMmu = this.spectrumHost.engine.mmu;
      this.spectrumTape = this.spectrumHost.engine.tape;
      this.booted = true;
      this.softDesynced = true;
      this.softError = null;
      this._breakpointHit = false;
      if (wasRunning) {
        this.running = true;
        this.spectrumHost.setRunning(true);
      }
      return;
    }

    if (!this.tick || !this.cpu) return;
    this.booted = false;
    this.reset.value = 1;
    this.aReset.value = 1;
    this.fsmLoad.value = 1;
    for (const we of this.seedWes) we.value = 1;
    this.dataClk.value = 0;
    this.phaseClk.value = 0;
    this.boot();
    if (wasRunning) this.running = true;
  }

  private pulse(sig: InputComponent): void {
    if (!this.tick) return;
    sig.value = 1;
    this.tick();
    sig.value = 0;
    this.tick();
  }

  /** One FSM phase on the transistor circuit (4 edges). */
  stepPhase(): void {
    if (!this.booted) this.boot();
    this.pulse(this.phaseClk);
    this.pulse(this.dataClk);
  }

  /** One full instruction: soft if speed=soft, else 10 gate phases. */
  stepInstruction(): void {
    if (!this.booted) this.boot();
    if (this.isSoft && this.soft && this.ram) {
      try {
        if (this.spectrumHost) {
          this.spectrumHost.step();
          this.soft = this.spectrumHost.engine.cpu;
          this.softDesynced = true;
          return;
        }
        if (this.spectrum) this.spectrum.pulseFrameIrq();
        softStep(this.soft, this.ram.bytes, this.softHooks());
        this.softDesynced = true;
        if (this.soft.halted && !this.spectrum) this.running = false;
      } catch (e) {
        this.running = false;
        this.softError = e instanceof Error ? e.message : String(e);
        console.error(e);
      }
      return;
    }
    for (let i = 0; i < 10; i++) this.stepPhase();
    this.stopIfGateHalted();
  }

  private stopIfGateHalted(): void {
    if (!this.cpu || !this.readPin) return;
    if (this.readPin(this.cpu.halted[0]!) === 1) this.running = false;
  }

  /**
   * Advance Run for one animation frame.
   * Soft: many interpreter ops. Gate: phases until PHASES cap or GATE_BUDGET_MS.
   * Returns whether any work ran (caller should refresh TTY).
   */
  tickBudget(): boolean {
    if (!this.running || !this.booted) return false;
    if (this.isSoft && this.spectrumHost && this.spectrum) {
      try {
        this.spectrumHost.setRunning(true);
        const wantRgba = this.shouldDrawSpectrumFrame();
        const frame = this.spectrumHost.tick(wantRgba);
        this.spectrumFrameCounter++;
        this.soft = this.spectrumHost.engine.cpu;
        this.spectrum = this.spectrumHost.engine.ula;
        this.spectrumMmu = this.spectrumHost.engine.mmu;
        this.spectrumTape = this.spectrumHost.engine.tape;
        this.softDesynced = true;
        if (frame) {
          if (frame.rgba.length) this.lastSpectrumRgba = frame.rgba;
          this.running = frame.running;
          if (frame.breakpointHit || frame.breakWriteHit) this.running = false;
          this.spectrumHost.syncAyTo(this.ayAudio.chip);
          this.ayAudio.playFrame(frame.tStates, frame.beeper);
        }
        const softErr = this.spectrumHost.lastSoftError ?? this.spectrumHost.engine.softError;
        if (softErr) this.softError = softErr;
      } catch (e) {
        this.running = false;
        this.softError = e instanceof Error ? e.message : String(e);
        console.error(e);
      }
      return true;
    }
    if (this.isSoft && this.soft && this.ram) {
      try {
        if (this.spectrum) {
          this.spectrum.pulseFrameIrq();
          this.spectrum.beginBeeperFrame();
        }
        softRun(this.soft, this.ram.bytes, this.phasesPerFrame, this.softHooks(), this.breakpointPc);
        this.softDesynced = true;
        if (
          this.breakpointPc != null &&
          this.soft &&
          (this.soft.pc & 0xffff) === (this.breakpointPc & 0xffff)
        ) {
          this.breakpointHit = true;
          this.running = false;
        }
        if (this.spectrum) {
          this.spectrumFrameCounter++;
          const tStates = Math.min(200_000, 69888 * Math.max(1, this.spectrumTurbo));
          this.ayAudio.playFrame(tStates, this.spectrum.beeperSegments());
        }
        if (this.soft.halted && !this.spectrum) this.running = false;
      } catch (e) {
        this.running = false;
        this.softError = e instanceof Error ? e.message : String(e);
        console.error(e);
      }
      return true;
    }
    const maxPhases = PHASES_PER_FRAME[this.speed as Exclude<RunSpeed, 'soft'>];
    const budgetMs = this.speed === 'free' ? FREE_BUDGET_MS : GATE_BUDGET_MS;
    const deadline = performance.now() + budgetMs;
    let n = 0;
    while (n < maxPhases && performance.now() < deadline && this.running) {
      this.stepPhase();
      n++;
      if (n % 10 === 0) this.stopIfGateHalted();
    }
    this.stopIfGateHalted();
    return n > 0;
  }

  setRunning(on: boolean): void {
    if (!this.attached) return;
    if (on && !this.booted) this.boot();
    if (on) this.breakpointHit = false;
    this.running = on;
    this.spectrumHost?.setRunning(on);
  }
}
