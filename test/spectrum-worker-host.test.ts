/**
 * SpectrumWorkerHost posts tape/watch/control messages when a Worker is active.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SpectrumWorkerHost } from '../src/machine/spectrum/SpectrumWorkerHost.js';
import { buildCodeTap } from '../src/machine/spectrum/tap.js';
import { buildMinimalTzx, parseTzxToTapBlocks } from '../src/machine/spectrum/tzx.js';

class FakeWorker {
  static last: FakeWorker | null = null;
  posted: unknown[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  constructor(_url: string | URL) {
    FakeWorker.last = this;
  }
  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
  terminate(): void {
    /* nop */
  }
}

describe('SpectrumWorkerHost → Worker posts', () => {
  const OrigWorker = globalThis.Worker;

  beforeEach(() => {
    FakeWorker.last = null;
    // @ts-expect-error test double
    globalThis.Worker = FakeWorker;
    // location.href for Worker URL resolution
    if (typeof location === 'undefined') {
      // @ts-expect-error jsdom-ish
      globalThis.location = { href: 'http://localhost/dist-file/index.html' };
    }
  });

  afterEach(() => {
    globalThis.Worker = OrigWorker;
  });

  it('posts rewind/seek/pause/watch/clearKeys when using Worker', () => {
    const host = new SpectrumWorkerHost();
    expect(host.start()).toBe(true);
    expect(host.usingWorker).toBe(true);
    const w = FakeWorker.last!;
    w.posted.length = 0;

    host.rewindTape();
    host.advanceTape();
    host.seekTape(2);
    host.setTapePaused(true);
    host.setTapeAutoStop(true);
    host.setWatchAddr(0x8000);
    host.clearKeys();
    host.clearTapeQueue();

    const types = w.posted.map((m) => (m as { type: string }).type);
    expect(types).toEqual([
      'rewindTape',
      'advanceTape',
      'seekTape',
      'setTapePaused',
      'setTapeAutoStop',
      'setWatchAddr',
      'clearKeys',
      'clearTapeQueue',
    ]);
    expect(w.posted.find((m) => (m as { type: string }).type === 'seekTape')).toMatchObject({
      index: 2,
    });
    expect(w.posted.find((m) => (m as { type: string }).type === 'setWatchAddr')).toMatchObject({
      addr: 0x8000,
    });
  });

  it('posts mountTap and getSnapshot', async () => {
    const host = new SpectrumWorkerHost();
    host.start();
    const w = FakeWorker.last!;
    w.posted.length = 0;
    const tap = buildCodeTap('T', 0x8000, new Uint8Array([1, 2, 3]));
    host.mountTap(tap, true);
    expect(w.posted.some((m) => (m as { type: string }).type === 'mountTap')).toBe(true);

    w.posted.length = 0;
    const snapP = host.getSnapshot(1000);
    expect(w.posted[0]).toMatchObject({ type: 'getSnapshot' });
    const sna = new Uint8Array(49179);
    const z80 = new Uint8Array(100);
    const scr = new Uint8Array(6912);
    w.onmessage?.({
      data: {
        type: 'snapshot',
        sna: sna.buffer,
        z80: z80.buffer,
        scr: scr.buffer,
      },
    } as MessageEvent);
    const snap = await snapP;
    expect(snap.sna.length).toBe(49179);
    expect(snap.scr.length).toBe(6912);
  });

  it('syncs border and softError from frame messages', () => {
    const host = new SpectrumWorkerHost();
    host.start();
    const w = FakeWorker.last!;
    host.engine.boot('48');
    w.onmessage?.({
      data: {
        type: 'frame',
        ayRegs: new ArrayBuffer(16),
        aySelected: 0,
        tStates: 69888,
        beeperStart: false,
        beeperTransitions: [],
        breakpointHit: false,
        breakWriteHit: false,
        running: true,
        tapePos: 0,
        tapeBlocks: 0,
        contendedWaits: 0,
        contendedHits: 0,
        pc: 0x1234,
        sp: 0xff4a,
        a: 0,
        f: 0,
        b: 0,
        c: 0,
        d: 0,
        e: 0,
        h: 0,
        l: 0,
        ix: 0,
        iy: 0,
        i: 0x3f,
        r: 0,
        im: 1,
        iff1: true,
        iff2: true,
        halted: false,
        model: '48',
        trdosPaged: false,
        port7ffd: 0x20,
        watchAddr: 0x4000,
        watchBytes: new ArrayBuffer(64),
        border: 2,
        softError: 'boom',
      },
    } as MessageEvent);
    expect(host.engine.ula.border).toBe(2);
    expect(host.lastSoftError).toBe('boom');
    expect(host.engine.cpu.pc).toBe(0x1234);
  });
});

describe('TZX soft-skip unsupported recording blocks', () => {
  it('skips ID15/18/19 and still extracts ID10', () => {
    const body = new Uint8Array(19);
    body[0] = 0x00; // flag header
    body.fill(0x20, 1, 11);
    body[11] = 1;
    body[12] = 0;
    // rest zero
    const base = buildMinimalTzx(body);
    // Append ID15 with empty samples
    const id15 = new Uint8Array(1 + 2 + 1 + 3);
    id15[0] = 0x15;
    // pause 0, used bits 0, len 0
    const out = new Uint8Array(base.length + id15.length);
    out.set(base);
    out.set(id15, base.length);
    const warnings: string[] = [];
    const blocks = parseTzxToTapBlocks(out, warnings);
    expect(blocks.length).toBe(1);
    expect(warnings.some((w) => /0x15/.test(w))).toBe(true);
  });
});

describe('spectrumBasicAcceptsKeys 128', () => {
  it('accepts 128 editor PC range', async () => {
    const { spectrumBasicAcceptsKeys } = await import('../src/machine/spectrum/ready.js');
    const cpu = { pc: 0x0c00, iff1: true } as import('../src/machine/softZ80.js').SoftZ80State;
    expect(spectrumBasicAcceptsKeys(cpu, '128')).toBe(true);
    expect(spectrumBasicAcceptsKeys({ ...cpu, pc: 0x1f3e }, '128')).toBe(false);
  });
});
