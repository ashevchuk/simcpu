/**
 * Spectrum soft-run Worker entry (classic script compatible).
 * Built to dist-file/spectrum-worker.js for file:// loads.
 */

import { SpectrumEngine } from './engine.js';
import type { WorkerInMsg, WorkerOutMsg } from './workerProtocol.js';

const engine = new SpectrumEngine();

function post(msg: WorkerOutMsg, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

function onMsg(ev: MessageEvent<WorkerInMsg>): void {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'boot':
        engine.boot(msg.model);
        break;
      case 'bootTrdos':
        engine.bootTrdos();
        break;
      case 'tick': {
        const r = engine.tickFrame(msg.wantRgba);
        const ay = r.ayRegs.slice().buffer;
        const watch = new Uint8Array(64);
        const wa = engine.watchAddr & 0xffff;
        for (let i = 0; i < 64; i++) watch[i] = engine.mmu.read((wa + i) & 0xffff);
        const cpu = engine.cpu;
        const out: WorkerOutMsg = {
          type: 'frame',
          ayRegs: ay,
          aySelected: r.aySelected,
          tStates: r.tStates,
          beeperStart: r.beeper.startEar,
          beeperTransitions: r.beeper.transitions,
          breakpointHit: r.breakpointHit,
          breakWriteHit: r.breakWriteHit,
          running: r.running,
          tapePos: r.tapePos,
          tapeBlocks: r.tapeBlocks,
          contendedWaits: r.contendedWaits,
          contendedHits: r.contendedHits,
          pc: cpu.pc,
          sp: cpu.sp,
          a: cpu.a,
          f: cpu.f,
          b: cpu.b,
          c: cpu.c,
          d: cpu.d,
          e: cpu.e,
          h: cpu.h,
          l: cpu.l,
          ix: cpu.ix,
          iy: cpu.iy,
          i: cpu.i,
          r: cpu.r,
          im: cpu.im,
          iff1: cpu.iff1,
          iff2: cpu.iff2,
          halted: cpu.halted,
          model: engine.mmu.model,
          trdosPaged: engine.mmu.trdosPaged,
          port7ffd: engine.mmu.port7ffd,
          watchAddr: wa,
          watchBytes: watch.buffer,
          border: engine.ula.border & 7,
          softError: engine.softError,
        };
        if (msg.wantRgba) {
          const copy = r.rgba.slice().buffer;
          out.rgba = copy;
          post(out, [copy, ay, watch.buffer]);
        } else {
          post(out, [ay, watch.buffer]);
        }
        return;
      }
      case 'step':
        engine.step();
        break;
      case 'stepOver':
        engine.stepOver();
        break;
      case 'nmi':
        engine.nmi();
        break;
      case 'setRunning':
        engine.running = msg.on;
        break;
      case 'setTurbo':
        engine.setTurbo(msg.turbo);
        break;
      case 'setBreakpointPc':
        engine.setBreakpointPc(msg.pc);
        break;
      case 'setBreakWriteAddr':
        engine.setBreakWriteAddr(msg.addr);
        break;
      case 'poke':
        engine.poke(msg.addr, msg.val);
        break;
      case 'setKey':
        engine.setKey(msg.label, msg.down);
        break;
      case 'clearKeys':
        engine.ula.clearKeys();
        break;
      case 'setWatchAddr':
        engine.watchAddr = msg.addr & 0xffff;
        break;
      case 'setKempston':
        engine.setKempston(msg.bit, msg.down);
        break;
      case 'mountTap': {
        const { blocks } = engine.mountTap(new Uint8Array(msg.data), !!msg.cold);
        post({ type: 'mounted', kind: 'tap', blocks });
        return;
      }
      case 'mountTzx': {
        const { blocks } = engine.mountTzx(new Uint8Array(msg.data), !!msg.cold);
        post({ type: 'mounted', kind: 'tzx', blocks });
        return;
      }
      case 'mountTrd': {
        const trd = engine.mountTrd(new Uint8Array(msg.data));
        post({ type: 'mounted', kind: 'trd', label: trd.label, sides: trd.sides });
        return;
      }
      case 'enqueueTape':
        engine.enqueueTape({
          name: msg.name,
          kind: msg.kind,
          data: new Uint8Array(msg.data),
        });
        break;
      case 'clearTapeQueue':
        engine.clearTapeQueue();
        break;
      case 'rewindTape':
        engine.tape?.reset();
        break;
      case 'advanceTape':
        engine.tape?.next();
        break;
      case 'seekTape':
        engine.tape?.seek(msg.index);
        break;
      case 'setTapePaused':
        engine.tapePaused = msg.on;
        break;
      case 'setTapeAutoStop':
        engine.tapeAutoStop = msg.on;
        break;
      case 'loadSna':
        engine.loadSna(new Uint8Array(msg.data));
        engine.running = true;
        break;
      case 'loadZ80':
        engine.loadZ80(new Uint8Array(msg.data));
        engine.running = true;
        break;
      case 'loadScr':
        engine.loadScr(new Uint8Array(msg.data));
        break;
      case 'setRom48Basic':
        engine.setRom48Basic(msg.on);
        break;
      case 'getSnapshot': {
        const sna = engine.saveSna().buffer.slice(0) as ArrayBuffer;
        const z80 = engine.saveZ80().buffer.slice(0) as ArrayBuffer;
        const scr = engine.saveScr().buffer.slice(0) as ArrayBuffer;
        post({ type: 'snapshot', sna, z80, scr }, [sna, z80, scr]);
        return;
      }
      default:
        break;
    }
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

self.onmessage = onMsg;
