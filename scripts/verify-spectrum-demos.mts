/**
 * Honest Spectrum demo verification: refuse blank white paper.
 * Run: npx vite-node scripts/verify-spectrum-demos.mts
 */
import { SPECTRUM_GAMES, decodeSpectrumGame } from '../src/machine/spectrum/gamesData.ts';
import { SpectrumEngine } from '../src/machine/spectrum/engine.ts';
import { spectrumBasicAcceptsKeys } from '../src/machine/spectrum/ready.ts';
import { SPEC_FRAME_W, SPEC_FRAME_H } from '../src/machine/spectrum/video.ts';

function colourBuckets(rgba: Uint8Array): Map<string, number> {
  const buckets = new Map<string, number>();
  for (let i = 0; i < rgba.length; i += 64) {
    const key = `${rgba[i]! >> 5},${rgba[i + 1]! >> 5},${rgba[i + 2]! >> 5}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  return buckets;
}

/** True if the frame is essentially cleared Spectrum paper (white/grey) + maybe one border. */
function isBlankWhite(buckets: Map<string, number>): boolean {
  const ranked = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return true;
  const dominantShare = ranked[0]![1] / ([...buckets.values()].reduce((a, b) => a + b, 0) || 1);
  const [rq, gq, bq] = ranked[0]![0].split(',').map(Number);
  const nearWhite = (rq ?? 0) >= 6 && (gq ?? 0) >= 6 && (bq ?? 0) >= 6;
  // Old broken rainbow: almost all samples near-white, ≤2 buckets total.
  return nearWhite && dominantShare > 0.85 && ranked.length <= 2;
}

function runFrames(eng: SpectrumEngine, n: number, rgba = false): void {
  for (let i = 0; i < n; i++) eng.tickFrame(rgba);
}

function pulseKey(eng: SpectrumEngine, label: string, frames = 4): void {
  eng.setKey(label, true);
  runFrames(eng, frames);
  eng.setKey(label, false);
  runFrames(eng, 2);
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

type Report = { id: string; ok: boolean; detail: string };

function verify(entry: (typeof SPECTRUM_GAMES)[number]): Report {
  const eng = new SpectrumEngine();
  const buf = decodeSpectrumGame(entry);
  eng.running = true;

  if (entry.kind === 'sna') {
    eng.loadSna(buf);
    eng.running = true;
    runFrames(eng, 12, true);
  } else {
    eng.boot('48');
    eng.mountTap(buf, true);
    eng.running = true;
    let basicAt = -1;
    for (let i = 0; i < 1500; i++) {
      eng.tickFrame(false);
      if (spectrumBasicAcceptsKeys(eng.cpu, '48')) {
        basicAt = i;
        break;
      }
    }
    if (basicAt < 0) {
      return { id: entry.id, ok: false, detail: `BASIC timeout softError=${eng.softError}` };
    }
    typeLoadEmpty(eng);
    for (let i = 0; i < 5000; i++) {
      eng.tickFrame(false);
      if (!eng.tape || eng.tape.remaining <= 0) break;
    }
    runFrames(eng, 40, true);
  }

  const { rgba } = eng.tickFrame(true);
  if (rgba.length < SPEC_FRAME_W * SPEC_FRAME_H * 4) {
    return { id: entry.id, ok: false, detail: `bad rgba len ${rgba.length}` };
  }
  const buckets = colourBuckets(rgba);
  const blank = isBlankWhite(buckets);
  const ok = !blank && !eng.softError && buckets.size >= 2;
  return {
    id: entry.id,
    ok,
    detail: blank
      ? `BLANK_WHITE colours=${buckets.size}`
      : `colours=${buckets.size} border=${eng.ula.border} pc=${(eng.cpu.pc & 0xffff).toString(16)}${eng.softError ? ` ERR=${eng.softError}` : ''}`,
  };
}

const reports: Report[] = [];
for (const entry of SPECTRUM_GAMES) {
  try {
    reports.push(verify(entry));
  } catch (e) {
    reports.push({
      id: entry.id,
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}

let failed = 0;
for (const r of reports) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}: ${r.detail}`);
  if (!r.ok) failed++;
}
console.log(failed === 0 ? `\nALL ${reports.length} demos OK` : `\n${failed}/${reports.length} FAILED`);
process.exit(failed === 0 ? 0 : 1);
