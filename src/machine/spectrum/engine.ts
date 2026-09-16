/**
 * Pure soft Spectrum engine (no DOM). Used on the main thread and in a Worker.
 */

import { createSoftZ80, softNmi, softRun, softStep, type SoftMemHooks, type SoftZ80State } from '../softZ80.js';
import { Ay8912 } from './ay8912.js';
import { BetaDisk } from './betaDisk.js';
import { bootSpectrum } from './boot.js';
import {
  ContendedStub,
  ExpansionStub,
  parseTrd,
  type TrdInfo,
} from './expansions.js';
import { SpectrumMmu, type SpectrumModel } from './mmu.js';
import { applySna, isSna128, saveSna } from './sna.js';
import { applyZ80, peekZ80Model, saveZ80 } from './z80snap.js';
import { SpectrumTape, trapLdBytes } from './tap.js';
import { SpectrumTapeFromTzx } from './tzx.js';
import { loadScr, saveScr } from './scr.js';
import { SpectrumUla } from './ula.js';
import {
  renderSpectrumFrame,
  SPEC_FRAME_H,
  SPEC_FRAME_W,
  spectrumFlashPhase,
} from './video.js';

export const SPECTRUM_OPS_PER_FRAME = 48000;

export type SpectrumTurbo = 0.5 | 1 | 2 | 4 | 8;

export type TapeQueueItem = { name: string; kind: 'tap' | 'tzx'; data: Uint8Array };

export type SpectrumFrameResult = {
  rgba: Uint8Array;
  beeper: { startEar: boolean; transitions: { frac: number; bit: boolean }[] };
  ayRegs: Uint8Array;
  aySelected: number;
  tStates: number;
  breakpointHit: boolean;
  breakWriteHit: boolean;
  running: boolean;
  tapePos: number;
  tapeBlocks: number;
  contendedWaits: number;
  contendedHits: number;
};

/** Peek opcode at PC via MMU (for step-over). */
function peekOp(mmu: SpectrumMmu, pc: number): number {
  return mmu.read(pc & 0xffff) & 0xff;
}

/** Return address after CALL nn / conditional CALL / RST if step-over applies. */
export function stepOverTarget(mmu: SpectrumMmu, cpu: SoftZ80State): number | null {
  const pc = cpu.pc & 0xffff;
  const op = peekOp(mmu, pc);
  if (op === 0xcd) return (pc + 3) & 0xffff; // CALL nn
  if ((op & 0xc7) === 0xc4) return (pc + 3) & 0xffff; // CALL cc,nn
  if ((op & 0xc7) === 0xc7) return (pc + 1) & 0xffff; // RST
  return null;
}

export class SpectrumEngine {
  ula = new SpectrumUla();
  mmu = new SpectrumMmu();
  cpu: SoftZ80State = createSoftZ80(0xffff);
  ay = new Ay8912();
  contended = new ContendedStub();
  expansion = new ExpansionStub();
  beta = new BetaDisk();
  tape: SpectrumTape | null = null;
  tapePaused = false;
  tapeAutoStop = false;
  tapeQueue: TapeQueueItem[] = [];
  trdDisk: TrdInfo | null = null;
  breakpointPc: number | null = null;
  breakWriteAddr: number | null = null;
  breakpointHit = false;
  breakWriteHit = false;
  ephemeralBreakPc: number | null = null;
  running = false;
  turbo: SpectrumTurbo = 1;
  frameSkip = 1;
  frameCounter = 0;
  softError: string | null = null;
  /** UI memory-watch base (also sent in worker frames). */
  watchAddr = 0x4000;
  private rgba = new Uint8Array(SPEC_FRAME_W * SPEC_FRAME_H * 4);
  private flat = new Uint8Array(0x10000);
  private lastLoadBlockOk = false;
  private prevWaitUnits = 0;

  boot(model: SpectrumModel): void {
    bootSpectrum(this.mmu, model, this.ula);
    this.cpu = createSoftZ80(0xffff);
    this.cpu.pc = 0;
    this.ay.reset();
    this.contended.reset();
    this.expansion.reset();
    this.beta.reset();
    this.tape = null;
    this.breakpointHit = false;
    this.breakWriteHit = false;
    this.softError = null;
    this.running = true;
  }

  /** Page TR-DOS ROM and restart at $0000. */
  bootTrdos(): void {
    if (this.mmu.trdosRom.every((b) => b === 0)) {
      bootSpectrum(this.mmu, this.mmu.model, this.ula);
    }
    this.mmu.trdosPaged = true;
    this.cpu = createSoftZ80(0xffff);
    this.cpu.pc = 0;
    this.running = true;
    this.softError = null;
  }

  /** Switch 128 editor ROM ↔ 48 BASIC (bit4 of 7FFD). */
  setRom48Basic(on: boolean): void {
    if (this.mmu.model !== '128') return;
    if (this.mmu.pagingLocked) return;
    const bit = on ? 0x10 : 0;
    this.mmu.port7ffd = (this.mmu.port7ffd & ~0x10) | bit;
  }

  hooks(): SoftMemHooks {
    const ula = this.ula;
    const mmu = this.mmu;
    const tape = this.tape;
    const beta = this.beta;
    return {
      addrBits: 16,
      clearOnReadKeys: false,
      memRead: (addr) => {
        this.contended.noteAccess(addr);
        return mmu.read(addr);
      },
      memWrite: (addr, v) => {
        this.contended.noteAccess(addr);
        if (this.breakWriteAddr != null && (addr & 0xffff) === this.breakWriteAddr) {
          this.breakWriteHit = true;
          this.running = false;
        }
        mmu.write(addr, v);
      },
      portIn: (port) => {
        if (mmu.trdosPaged) {
          if (BetaDisk.isCommandPort(port)) return beta.inStatus();
          if (BetaDisk.isTrackPort(port)) return beta.inTrack();
          if (BetaDisk.isSectorPort(port)) return beta.inSector();
          if (BetaDisk.isDataPort(port)) return beta.inData();
          if (BetaDisk.isSystemPort(port)) return mmu.trdosPaged ? 0x01 : 0x00;
        }
        if (Ay8912.isSelectPort(port)) return this.ay.readData();
        if ((port & 0xff) === 0xfe) this.contended.noteFePort();
        return ula.portIn(port);
      },
      portOut: (port, val) => {
        if (mmu.trdosPaged) {
          if (BetaDisk.isCommandPort(port)) {
            beta.outCommand(val);
            return;
          }
          if (BetaDisk.isTrackPort(port)) {
            beta.outTrack(val);
            return;
          }
          if (BetaDisk.isSectorPort(port)) {
            beta.outSector(val);
            return;
          }
          if (BetaDisk.isDataPort(port)) {
            beta.outData(val);
            return;
          }
          if (BetaDisk.isSystemPort(port)) {
            mmu.trdosPaged = beta.outSystem(val);
            return;
          }
        } else if (BetaDisk.isSystemPort(port)) {
          // Allow paging in via system port even when not yet paged
          const page = beta.outSystem(val);
          if (page) mmu.trdosPaged = true;
          return;
        }
        if (SpectrumMmu.isPort7ffd(port) && mmu.model === '128') {
          mmu.out7ffd(val);
          return;
        }
        if (ExpansionStub.isPort1ffd(port)) {
          this.expansion.out1ffd(val);
          return;
        }
        if (ExpansionStub.isDivmmcPort(port)) {
          this.expansion.outDivmmc(val);
          return;
        }
        if (Ay8912.isSelectPort(port)) {
          this.ay.select(val);
          return;
        }
        if (Ay8912.isDataPort(port)) {
          this.ay.writeData(val);
          return;
        }
        if ((port & 0xff) === 0xfe) this.contended.noteFePort();
        ula.portOut(port, val);
      },
      irqPending: () => ula.irqPending,
      clearIrq: () => ula.clearIrq(),
      onStep: (step, max) => ula.setBeeperProgress(step / Math.max(1, max)),
      hostTrap: tape
        ? (cpu, bytes) => {
            if (this.tapePaused) return true; // busy-wait at LD-BYTES
            const before = tape.pos;
            const handled = trapLdBytes(cpu, bytes, tape, {
              read: (a) => mmu.read(a),
              write: (a, v) => mmu.write(a, v),
              setBorder: (b) => {
                ula.border = b & 7;
              },
            });
            if (handled && tape.pos > before) {
              this.lastLoadBlockOk = true;
              if (this.tapeAutoStop) this.running = false;
              this.promoteTapeQueue();
            }
            return handled;
          }
        : undefined,
    };
  }

  private promoteTapeQueue(): void {
    if (!this.tape || this.tape.remaining > 0) return;
    const next = this.tapeQueue.shift();
    if (!next) return;
    this.tape =
      next.kind === 'tzx' ? SpectrumTapeFromTzx(next.data) : SpectrumTape.fromBytes(next.data);
  }

  opsPerFrame(): number {
    return Math.max(1000, Math.floor(SPECTRUM_OPS_PER_FRAME * this.turbo));
  }

  setTurbo(t: SpectrumTurbo): void {
    this.turbo = t;
    this.frameSkip = t >= 8 ? 3 : t >= 4 ? 2 : 1;
  }

  setBreakpointPc(pc: number | null): void {
    this.breakpointPc = pc == null ? null : pc & 0xffff;
    this.breakpointHit = false;
  }

  setBreakWriteAddr(addr: number | null): void {
    this.breakWriteAddr = addr == null ? null : addr & 0xffff;
    this.breakWriteHit = false;
  }

  poke(addr: number, val: number): void {
    this.mmu.write(addr & 0xffff, val & 0xff);
  }

  step(): void {
    this.ula.pulseFrameIrq();
    softStep(this.cpu, this.flat, this.hooks());
  }

  stepOver(): void {
    const target = stepOverTarget(this.mmu, this.cpu);
    if (target == null) {
      this.step();
      return;
    }
    this.ephemeralBreakPc = target;
    this.running = true;
    this.tickFrame(false);
  }

  nmi(): void {
    softNmi(this.cpu, this.flat, this.hooks());
  }

  /**
   * One display frame of soft Run. When `wantRgba` is false, skip render (turbo skip).
   */
  tickFrame(wantRgba = true): SpectrumFrameResult {
    this.breakpointHit = false;
    this.breakWriteHit = false;
    this.lastLoadBlockOk = false;

    const breakPc =
      this.ephemeralBreakPc != null ? this.ephemeralBreakPc : this.breakpointPc;

    // Contended waits from the previous frame drain this frame's soft budget.
    this.contended.waitUnits = this.prevWaitUnits;
    const budget = this.contended.applyToBudget(this.opsPerFrame());
    this.contended.beginFrame();

    this.ula.pulseFrameIrq();
    this.ula.beginBeeperFrame();

    try {
      softRun(this.cpu, this.flat, budget, this.hooks(), breakPc);
    } catch (e) {
      this.softError = e instanceof Error ? e.message : String(e);
      this.running = false;
    }
    this.prevWaitUnits = this.contended.waitUnits;

    if (breakPc != null && (this.cpu.pc & 0xffff) === (breakPc & 0xffff)) {
      this.breakpointHit = true;
      this.running = false;
      if (this.ephemeralBreakPc === breakPc) this.ephemeralBreakPc = null;
    }
    if (this.breakWriteHit) this.running = false;

    this.frameCounter++;
    const tStates = Math.min(200_000, 69888 * Math.max(1, this.turbo));
    const beeper = this.ula.beeperSegments();
    const transitions = beeper.transitions.map((t) => ({ frac: t.frac, bit: t.bit }));

    if (wantRgba) {
      renderSpectrumFrame(
        this.mmu.displayBank(),
        this.ula.border,
        this.rgba,
        spectrumFlashPhase(performance.now()),
      );
    }

    return {
      rgba: this.rgba,
      beeper: { startEar: beeper.startEar, transitions },
      ayRegs: this.ay.regs.slice(),
      aySelected: this.ay.selected,
      tStates,
      breakpointHit: this.breakpointHit,
      breakWriteHit: this.breakWriteHit,
      running: this.running,
      tapePos: this.tape?.pos ?? 0,
      tapeBlocks: this.tape?.blocks.length ?? 0,
      contendedWaits: this.contended.waitUnits,
      contendedHits: this.contended.hits,
    };
  }

  loadSna(data: Uint8Array) {
    const model: SpectrumModel = isSna128(data) ? '128' : '48';
    this.boot(model);
    return applySna(this.mmu, this.cpu, this.ula, data);
  }

  loadZ80(data: Uint8Array) {
    const model = peekZ80Model(data);
    this.boot(model);
    return applyZ80(this.mmu, this.cpu, this.ula, data, this.ay);
  }

  saveSna(): Uint8Array {
    return saveSna(this.mmu, this.cpu, this.ula);
  }

  saveZ80(): Uint8Array {
    return saveZ80(this.mmu, this.cpu, this.ula, this.ay);
  }

  saveScr(): Uint8Array {
    return saveScr(this.mmu);
  }

  loadScr(data: Uint8Array): void {
    loadScr(this.mmu, data);
  }

  mountTap(data: Uint8Array, cold = false): { blocks: number; cold: boolean } {
    const wasCold = !this.mmu.rom0[0] || cold;
    if (wasCold) this.boot(this.mmu.model || '48');
    this.tape = SpectrumTape.fromBytes(data);
    this.running = true;
    return { blocks: this.tape.blocks.length, cold: wasCold };
  }

  mountTzx(data: Uint8Array, cold = false): { blocks: number; cold: boolean; warnings: string[] } {
    const wasCold = cold;
    if (wasCold) this.boot(this.mmu.model || '48');
    const warnings: string[] = [];
    this.tape = SpectrumTapeFromTzx(data, warnings);
    this.running = true;
    return { blocks: this.tape.blocks.length, cold: wasCold, warnings };
  }

  enqueueTape(item: TapeQueueItem): void {
    this.tapeQueue.push(item);
  }

  clearTapeQueue(): void {
    this.tapeQueue = [];
  }

  mountTrd(data: Uint8Array): TrdInfo {
    this.trdDisk = parseTrd(data);
    this.beta.mount(this.trdDisk);
    this.mmu.trdosPaged = false;
    return this.trdDisk;
  }

  setKey(label: string, down: boolean): void {
    this.ula.setKey(label, down);
  }

  setKempston(bit: 0 | 1 | 2 | 3 | 4, down: boolean): void {
    this.ula.setKempston(bit, down);
  }
}
