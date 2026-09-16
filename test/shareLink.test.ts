import { describe, expect, it } from 'vitest';
import { encodeShareHash, decodeShareHash } from '../src/sim/shareLink.js';
import type { SerializedProject } from '../src/sim/serialize.js';

function tinyProject(extra = ''): SerializedProject {
  return {
    format: 'z80-sim-project',
    version: 1,
    chipDefs: [],
    topCircuit: { components: [], wires: [] },
    // carry a marker through JSON for round-trip assert
    ...(extra ? { _note: extra } : {}),
  } as SerializedProject;
}

describe('shareLink #p=', () => {
  it('round-trips a small project', async () => {
    const project = tinyProject('hello');
    const enc = await encodeShareHash(project);
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;
    expect(enc.hash.startsWith('#p=')).toBe(true);
    const back = await decodeShareHash(enc.hash);
    expect(back?.format).toBe('z80-sim-project');
    expect((back as { _note?: string })?._note).toBe('hello');
  });

  it('rejects wrong format tag', async () => {
    const bad = { format: 'nope', version: 1, chipDefs: [], topCircuit: { components: [], wires: [] } };
    const json = JSON.stringify(bad);
    const b64 = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const back = await decodeShareHash(`#p=b${b64}`);
    expect(back).toBeNull();
  });

  it('returns null for non-#p hashes', async () => {
    expect(await decodeShareHash('#demo=rainbow')).toBeNull();
    expect(await decodeShareHash('')).toBeNull();
  });

  it('reports too-large projects', async () => {
    const huge = tinyProject('x'.repeat(2 * 1024 * 1024));
    const enc = await encodeShareHash(huge);
    expect(enc.ok).toBe(false);
    if (enc.ok) return;
    expect(enc.reason).toBe('too-large');
    expect(enc.size).toBeGreaterThan(1.5 * 1024 * 1024);
  });
});
