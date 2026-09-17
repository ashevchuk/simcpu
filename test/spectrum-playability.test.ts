/**
 * Headless playability: every bundled demo must load and keep the machine alive.
 * GLAZX uses IM 2 + HALT — regressions there freeze gameplay at TIME:99.
 */
import { describe, expect, it } from 'vitest';
import { SpectrumEngine } from '../src/machine/spectrum/engine.js';
import {
  SPECTRUM_GAMES,
  decodeSpectrumGame,
  type SpectrumGameEntry,
} from '../src/machine/spectrum/gamesData.js';
import { spectrumBasicAcceptsKeys } from '../src/machine/spectrum/ready.js';

function hashScreen(eng: SpectrumEngine): string {
  const bank = eng.mmu.displayBank();
  let h = 0;
  for (let i = 0; i < bank.length; i += 17) h = ((h * 131) + bank[i]!) >>> 0;
  return h.toString(16);
}

function runFrames(eng: SpectrumEngine, n: number): void {
  for (let i = 0; i < n; i++) eng.tickFrame(false);
}

function pulseKey(eng: SpectrumEngine, label: string, frames = 4): void {
  eng.setKey(label, true);
  runFrames(eng, frames);
  eng.setKey(label, false);
  runFrames(eng, 3);
}

function typeLoadEmpty(eng: SpectrumEngine): void {
  eng.ula.clearKeys();
  runFrames(eng, 2);
  pulseKey(eng, 'J', 5);
  eng.setKey('Sym', true);
  runFrames(eng, 2);
  pulseKey(eng, 'P', 5);
  eng.setKey('Sym', false);
  runFrames(eng, 3);
  eng.setKey('Sym', true);
  runFrames(eng, 2);
  pulseKey(eng, 'P', 5);
  eng.setKey('Sym', false);
  runFrames(eng, 3);
  pulseKey(eng, 'Enter', 5);
  eng.ula.clearKeys();
}

function waitBasic(eng: SpectrumEngine, max = 1200): number {
  for (let i = 0; i < max; i++) {
    eng.tickFrame(false);
    if (spectrumBasicAcceptsKeys(eng.cpu, '48')) return i;
  }
  return -1;
}

function waitTapeDone(eng: SpectrumEngine, max = 4000): number {
  for (let i = 0; i < max; i++) {
    eng.tickFrame(false);
    if (!eng.tape) return i;
    if (eng.tape.remaining === 0 && eng.tape.pos >= eng.tape.blocks.length) return i;
  }
  return -1;
}

/** Mid-frame PC diversity — end-of-frame HALT alone is normal for vsync waits. */
function sampleMidFramePcs(eng: SpectrumEngine, frames = 40): Set<number> {
  const pcs = new Set<number>();
  const budget = Math.min(8000, eng.opsPerFrame());
  for (let f = 0; f < frames; f++) {
    eng.ula.pulseFrameIrq();
    eng.ula.beginBeeperFrame();
    // Peek activity by stepping a slice via tickFrame's path
    eng.tickFrame(false);
    pcs.add(eng.cpu.pc & 0xffff);
  }
  // Also force a few single steps after IRQ while halted
  for (let i = 0; i < 20; i++) {
    if (eng.cpu.halted) {
      eng.ula.pulseFrameIrq();
      eng.step();
    } else {
      eng.step();
    }
    pcs.add(eng.cpu.pc & 0xffff);
  }
  void budget;
  return pcs;
}

function pokeMenuAndPlay(eng: SpectrumEngine, id: string): void {
  eng.setKey('Space', true);
  runFrames(eng, 40);
  eng.setKey('Space', false);
  runFrames(eng, 20);

  for (const k of ['Enter', '0', '1', '2', 'Space']) {
    pulseKey(eng, k, 6);
    runFrames(eng, 25);
  }

  if (id === 'glazx') {
    for (let r = 0; r < 40; r++) {
      for (const k of ['W', 'A', 'S', 'D', 'F'] as const) {
        eng.setKey(k, true);
        runFrames(eng, 3);
        eng.setKey(k, false);
        runFrames(eng, 2);
      }
    }
  } else if (id === 'pzxl') {
    for (let r = 0; r < 30; r++) {
      eng.setKempston(0, true);
      runFrames(eng, 4);
      eng.setKempston(0, false);
      eng.setKempston(4, true);
      runFrames(eng, 4);
      eng.setKempston(4, false);
    }
  } else {
    for (let r = 0; r < 25; r++) {
      for (const k of ['Q', 'A', 'O', 'P', 'Space', 'M', 'Enter'] as const) {
        eng.setKey(k, true);
        runFrames(eng, 3);
        eng.setKey(k, false);
      }
      eng.setKempston(3, true);
      runFrames(eng, 3);
      eng.setKempston(3, false);
      eng.setKempston(4, true);
      runFrames(eng, 3);
      eng.setKempston(4, false);
    }
  }
}

describe('Spectrum demo playability', () => {
  for (const entry of SPECTRUM_GAMES) {
    it(
      `${entry.id} loads and keeps running`,
      () => {
        const report = playDemo(entry);
        // eslint-disable-next-line no-console
        console.log(entry.id, report);
        expect(report.softError, report.detail).toBeNull();
        expect(report.loaded, report.detail).toBe(true);
        expect(report.alive, report.detail).toBe(true);
      },
      120_000,
    );
  }
});

function playDemo(entry: SpectrumGameEntry) {
  const eng = new SpectrumEngine();
  const buf = decodeSpectrumGame(entry);
  const detailParts: string[] = [];

  if (entry.kind === 'sna') {
    eng.loadSna(buf);
    eng.running = true;
    const h0 = hashScreen(eng);
    const border0 = eng.ula.border;
    runFrames(eng, 5);
    // Rainbow parks in JR -2 after one attr pass — require multi-colour paper attrs.
    const attrs = eng.mmu.displayBank().subarray(0x1800, 0x1b00);
    const colours = new Set<number>();
    for (const a of attrs) colours.add((a >> 3) & 7);
    const painted = colours.size >= 4 || h0 !== hashScreen(eng);
    runFrames(eng, 40);
    const borderMoved = eng.ula.border !== border0;
    const ayLive = entry.id === 'ay-beep' && (eng.ay.regs[8]! & 0x0f) > 0;
    detailParts.push(
      `sna pc=${(eng.cpu.pc & 0xffff).toString(16)} painted=${painted} border=${borderMoved} ay=${ayLive}`,
    );
    return {
      softError: eng.softError,
      loaded: true,
      alive: !eng.softError && (painted || borderMoved || ayLive),
      detail: detailParts.join('; '),
      im: eng.cpu.im,
    };
  }

  eng.mountTap(buf, true);
  eng.running = true;
  const basicAt = waitBasic(eng);
  detailParts.push(`basic@${basicAt}`);
  typeLoadEmpty(eng);
  const tapeAt = waitTapeDone(eng);
  detailParts.push(`tape@${tapeAt} pos=${eng.tape?.pos}/${eng.tape?.blocks.length}`);

  pokeMenuAndPlay(eng, entry.id);

  const hBefore = hashScreen(eng);
  const midPcs = sampleMidFramePcs(eng, 50);
  const hAfter = hashScreen(eng);
  const screenChurn = hBefore !== hAfter;

  // Stuck IM2 HALT: irq stays pending, PC frozen, no screen churn.
  const stuckIm2Halt =
    eng.cpu.im === 2 &&
    eng.cpu.halted &&
    eng.ula.irqPending &&
    midPcs.size <= 1 &&
    !screenChurn;

  detailParts.push(
    `im=${eng.cpu.im} pc=${(eng.cpu.pc & 0xffff).toString(16)} halt=${eng.cpu.halted} irq=${eng.ula.irqPending} midPcs=${midPcs.size} scr=${screenChurn}`,
  );

  const leftRom = [...midPcs].some((pc) => pc >= 0x4000) || (eng.cpu.pc & 0xffff) >= 0x4000;
  const alive =
    !eng.softError &&
    tapeAt >= 0 &&
    !stuckIm2Halt &&
    midPcs.size >= 2 &&
    (leftRom || screenChurn);

  return {
    softError: eng.softError,
    loaded: tapeAt >= 0,
    alive,
    detail: detailParts.join('; '),
    basicAt,
    tapeAt,
    midPcs: midPcs.size,
    screenChurn,
    stuckIm2Halt,
    leftRom,
    im: eng.cpu.im,
  };
}
