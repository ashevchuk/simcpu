/**
 * Audit third_party Spectrum/CPM fixtures on disk (sizes, parse, catalog sync).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SPECTRUM_GAMES,
  decodeSpectrumGame,
} from '../src/machine/spectrum/gamesData.js';
import { parseTap } from '../src/machine/spectrum/tap.js';
import { isSna48, isSna128 } from '../src/machine/spectrum/sna.js';
import { loadCpm22DiskImage } from '../src/machine/cpm/cpm22Disk.js';
import { loadRogueDiskImage } from '../src/machine/cpm/rogueDisk.js';

const root = join(import.meta.dirname, '..');
const specDir = join(root, 'third_party/spectrum');
const gamesDir = join(specDir, 'games');
const cpmDir = join(root, 'third_party/cpm');

function sha1(buf: Buffer | Uint8Array): string {
  return createHash('sha1').update(buf).digest('hex');
}

describe('third_party Spectrum ROMs', () => {
  const expected: Record<string, { size: number; sha1: string }> = {
    '48.rom': { size: 16384, sha1: '5ea7c2b824672e914525d1d5c419d71b84a426a2' },
    '128-0.rom': { size: 16384, sha1: '4f4b11ec22326280bdb96e3baf9db4b4cb1d02c5' },
    '128-1.rom': { size: 16384, sha1: '80080644289ed93d71a1103992a154cc9802b2fa' },
    '128.rom': { size: 32768, sha1: '' }, // concatenation — size only
    'trdos.rom': { size: 16384, sha1: '0a74bd34538a03d0e1d214b425d95c14ad10c8c4' },
  };

  for (const [file, meta] of Object.entries(expected)) {
    it(`${file} has expected size${meta.sha1 ? ' + sha1' : ''}`, () => {
      const path = join(specDir, file);
      expect(existsSync(path)).toBe(true);
      const buf = readFileSync(path);
      expect(buf.length).toBe(meta.size);
      if (meta.sha1) expect(sha1(buf)).toBe(meta.sha1);
    });
  }

  it('128.rom is 128-0 || 128-1', () => {
    const a = readFileSync(join(specDir, '128-0.rom'));
    const b = readFileSync(join(specDir, '128-1.rom'));
    const c = readFileSync(join(specDir, '128.rom'));
    expect(Buffer.concat([a, b]).equals(c)).toBe(true);
  });
});

describe('third_party Spectrum games/', () => {
  it('every META file on disk is in SPECTRUM_GAMES catalog', () => {
    const onDisk = readdirSync(gamesDir).filter((f) => /\.(tap|sna)$/i.test(f));
    const catalogFiles = new Set(SPECTRUM_GAMES.map((g) => g.file));
    for (const f of onDisk) {
      expect(catalogFiles.has(f), `${f} missing from gamesData catalog`).toBe(true);
    }
  });

  it('catalog bytes match files on disk', () => {
    for (const entry of SPECTRUM_GAMES) {
      const disk = readFileSync(join(gamesDir, entry.file));
      const embedded = decodeSpectrumGame(entry);
      expect(embedded.length).toBe(disk.length);
      expect(Buffer.from(embedded).equals(disk)).toBe(true);
    }
  });

  it('each game file parses as TAP or SNA', () => {
    for (const entry of SPECTRUM_GAMES) {
      const buf = readFileSync(join(gamesDir, entry.file));
      if (entry.kind === 'sna') {
        expect(isSna48(buf) || isSna128(buf)).toBe(true);
      } else {
        expect(parseTap(buf).length).toBeGreaterThan(0);
      }
    }
  });

  it('no duplicate pZXl.tap at spectrum root (games/ only)', () => {
    expect(existsSync(join(specDir, 'pZXl.tap'))).toBe(false);
  });
});

describe('third_party CP/M disks', () => {
  it('cpm22-1.dsk matches embedded image', () => {
    const disk = readFileSync(join(cpmDir, 'cpm22-1.dsk'));
    expect(disk.length).toBe(256256);
    expect(Buffer.from(loadCpm22DiskImage()).equals(disk)).toBe(true);
  });

  it('rogue.dsk matches embedded image', () => {
    const disk = readFileSync(join(cpmDir, 'rogue.dsk'));
    expect(disk.length).toBe(256256);
    expect(Buffer.from(loadRogueDiskImage()).equals(disk)).toBe(true);
  });
});
