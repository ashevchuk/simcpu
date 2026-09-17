import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LAB_CURRICULUM } from '../src/ui/LabCurriculum.js';

describe('Lab manual source of truth', () => {
  const helpDir = join(process.cwd(), 'src/assets/help');
  const manualSrc = readFileSync(join(process.cwd(), 'src/ui/LabManual.ts'), 'utf8');

  it('embeds LAB_CURRICULUM in the course section', () => {
    expect(LAB_CURRICULUM.length).toBeGreaterThanOrEqual(8);
    expect(manualSrc).toContain('LAB_CURRICULUM.map');
  });

  it('documents every menubar menu with screenshots', () => {
    for (const id of ['menu-file', 'menu-place', 'menu-insert', 'menu-library', 'menu-edit', 'menu-view', 'menu-help']) {
      expect(manualSrc).toContain(`id: '${id}'`);
    }
    for (const name of ['30-menu-file.png', '32-menu-insert.png', '35-menu-help.png']) {
      expect(manualSrc).toContain(name);
    }
  });

  it('documents Soft machine ROM/RAM, Z80, Spectrum load/demos', () => {
    for (const id of [
      'rom-ram',
      'z80',
      'spectrum',
      'spectrum-load',
      'spectrum-demos',
      'spectrum-tape',
      'spectrum-controls',
      'spectrum-debug',
      'logic-analyzer',
    ]) {
      expect(manualSrc).toContain(`id: '${id}'`);
    }
    expect(manualSrc).toContain('37-spectrum-machine.png');
    expect(manualSrc).toContain('40-logic-analyzer-window.png');
    expect(manualSrc).toContain('43-spectrum-media-bar.png');
    expect(manualSrc).toContain('Load .SNA');
  });

  it('uses a tree nav and is resizable', () => {
    expect(manualSrc).toContain('NAV_TREE');
    expect(manualSrc).toContain('resize: both');
    expect(manualSrc).toContain("kind: 'group'");
  });

  it('ships screenshot assets referenced by the manual', () => {
    const pngs = readdirSync(helpDir).filter((f) => f.endsWith('.png'));
    expect(pngs.length).toBeGreaterThanOrEqual(40);
    expect(pngs).toContain('28-contention-bus.png');
    expect(pngs).toContain('30-menu-file.png');
    expect(pngs).toContain('40-logic-analyzer-window.png');
    expect(pngs).toContain('43-spectrum-media-bar.png');
  });

  it('rejects blank IDLE menu / rom-viewer shots (min file size)', () => {
    // Empty IDLE full-page shots were ~20KB; real menu-over-circuit shots are >100KB.
    for (const name of [
      '30-menu-file.png',
      '31-menu-place.png',
      '32-menu-insert.png',
      '33-menu-edit.png',
      '34-menu-view.png',
      '35-menu-help.png',
      '36-menu-library.png',
      '38-rom-viewer.png',
    ]) {
      const bytes = statSync(join(helpDir, name)).size;
      expect(bytes, name).toBeGreaterThan(45_000);
    }
  });
});
