import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSlot,
  createAutosaveScheduler,
  getSessionMeta,
  loadSlotSync,
  saveSessionMeta,
  saveSlot,
  touchSlot,
} from '../src/sim/autosave.js';
import type { SerializedProject } from '../src/sim/serialize.js';

function project(label: string): SerializedProject {
  return {
    format: 'z80-sim-project',
    version: 1,
    chipDefs: [],
    topCircuit: { components: [], wires: [] },
    label,
  } as SerializedProject;
}

/** Minimal localStorage + document/window polyfill for Node vitest. */
function installLocalStorage(): void {
  const store = new Map<string, string>();
  const ls = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  vi.stubGlobal('localStorage', ls);
  vi.stubGlobal('indexedDB', {
    open: () => {
      throw new Error('indexedDB unused in unit test');
    },
  });
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', {
    addEventListener: () => {},
    removeEventListener: () => {},
  });
}

describe('autosave slots', () => {
  beforeEach(() => {
    installLocalStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('saveSlot / loadSlotSync round-trip', async () => {
    const where = await saveSlot('1', project('a'));
    expect(where).toBe('localStorage');
    const loaded = loadSlotSync('1');
    expect((loaded as { label?: string } | null)?.label).toBe('a');
  });

  it('getSessionMeta creates default slot', () => {
    const meta = getSessionMeta();
    expect(meta.activeId).toBe('1');
    expect(meta.slots.length).toBe(1);
  });

  it('scheduler bumps writeGen and detects conflict', async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const conflicts: string[] = [];
    let current = project('local');

    const sched = createAutosaveScheduler(() => current, {
      delayMs: 50,
      onStatus: (s) => statuses.push(s),
      onConflict: (id) => conflicts.push(id),
    });
    sched.adoptWriteGen('1');

    sched.schedule();
    await vi.advanceTimersByTimeAsync(60);
    await Promise.resolve();
    expect(loadSlotSync('1')).toBeTruthy();
    const genAfterSave = getSessionMeta().slots.find((s) => s.id === '1')?.writeGen ?? 0;
    expect(genAfterSave).toBeGreaterThan(0);

    const meta = getSessionMeta();
    const slot = meta.slots.find((s) => s.id === '1')!;
    slot.writeGen = genAfterSave + 5;
    saveSessionMeta(meta);
    touchSlot(meta, '1');

    current = project('stale');
    sched.schedule();
    await vi.advanceTimersByTimeAsync(60);
    await Promise.resolve();

    expect(conflicts).toContain('1');
    expect(statuses).toContain('conflict');
    expect((loadSlotSync('1') as { label?: string } | null)?.label).toBe('local');

    sched.dispose();
    vi.useRealTimers();
  });

  it('clearSlot removes project', async () => {
    await saveSlot('1', project('x'));
    await clearSlot('1');
    expect(loadSlotSync('1')).toBeNull();
  });
});
