/**
 * Clean Lab-manual screenshots for analyzer + Spectrum (39–51, 15, 37).
 * Prefer static dist (Worker + stable hash boot):
 *   npm run build:dist-file && npx serve dist-file -l 4173
 *   HELP_BASE=http://127.0.0.1:4173 npx vite-node scripts/capture-lab-help-deep.mts
 * Spectrum-only refresh: scripts/capture-lab-help-spectrum.mts
 */
import { chromium, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src/assets/help');
const base = process.env.HELP_BASE || 'http://127.0.0.1:5173';

async function dismissDialogs(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const ok = page.locator('.z80-dialog-overlay button.z80-dialog-primary');
    if (await ok.count()) {
      await ok.first().click();
      await page.waitForTimeout(200);
    } else break;
  }
}

async function scrubUi(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelector('.demo-teach-overlay')?.remove();
    document.querySelector('.sim-tutorial')?.remove();
    document.getElementById('lab-manual-css')?.remove();
    for (const el of document.querySelectorAll<HTMLElement>('.float-win')) {
      if (el.classList.contains('machine-panel') || el.classList.contains('logic-analyzer')) continue;
      el.hidden = true;
    }
  });
}

async function onlyMachinePanel(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelector('.demo-teach-overlay')?.remove();
    for (const el of document.querySelectorAll<HTMLElement>('.float-win')) {
      if (el.classList.contains('machine-panel')) {
        el.hidden = false;
        el.style.left = '32px';
        el.style.top = '40px';
        el.style.width = '740px';
        el.style.height = '820px';
        el.style.zIndex = '50';
      } else {
        el.hidden = true;
      }
    }
  });
}

async function shotEl(page: Page, sel: string, file: string): Promise<void> {
  const clip = await page.evaluate((selector) => {
    const n = document.querySelector(selector) as HTMLElement | null;
    if (!n) return null;
    n.hidden = false;
    n.removeAttribute('hidden');
    // Ensure ancestors aren't hiding us
    let p: HTMLElement | null = n;
    while (p) {
      if (p.hidden) {
        p.hidden = false;
        p.removeAttribute('hidden');
      }
      p = p.parentElement;
    }
    const r = n.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return {
      x: Math.max(0, r.x),
      y: Math.max(0, r.y),
      width: Math.min(r.width, 1400 - Math.max(0, r.x)),
      height: Math.min(r.height, 900 - Math.max(0, r.y)),
    };
  }, sel);
  if (!clip) throw new Error(`shotEl: missing/zero-size ${sel}`);
  await page.screenshot({ path: path.join(out, file), clip });
  console.log(file);
}

async function shotPage(page: Page, file: string): Promise<void> {
  await page.screenshot({ path: path.join(out, file) });
  console.log(file);
}

/** True when Spectrum canvas has several colours (rejects blank white/black). */
async function spectrumPainted(page: Page, minColours = 3): Promise<boolean> {
  return page.evaluate((min) => {
    const c = document.querySelector('canvas[data-canvas="spec"]') as HTMLCanvasElement | null;
    if (!c) return false;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const buckets = new Map<string, number>();
    for (let i = 0; i < data.length; i += 32) {
      const key = `${data[i]! >> 5},${data[i + 1]! >> 5},${data[i + 2]! >> 5}`;
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    return buckets.size >= min;
  }, minColours);
}

async function waitSpectrumPaint(page: Page, minColours = 3, ms = 25_000): Promise<void> {
  const start = Date.now();
  let last = 0;
  while (Date.now() - start < ms) {
    last = await page.evaluate(() => {
      const c = document.querySelector('canvas[data-canvas="spec"]') as HTMLCanvasElement | null;
      if (!c || c.width < 8) return 0;
      const ctx = c.getContext('2d');
      if (!ctx) return 0;
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      const buckets = new Set<string>();
      for (let i = 0; i < data.length; i += 32) {
        buckets.add(`${data[i]! >> 5},${data[i + 1]! >> 5},${data[i + 2]! >> 5}`);
      }
      return buckets.size;
    });
    if (last >= minColours) return;
    await page.waitForTimeout(400);
  }
  throw new Error(`Spectrum screen not painted (${minColours}+ colours) within ${ms}ms (got ${last})`);
}

async function openAnalyzerWindow(page: Page): Promise<boolean> {
  const canvas = page.locator('#canvas');
  const box = await canvas.boundingBox();
  if (!box) return false;
  // Dense grid over the right/center where LA sits after fit on lab-analyzer
  for (let fx = 0.35; fx <= 0.85; fx += 0.05) {
    for (let fy = 0.25; fy <= 0.75; fy += 0.05) {
      await page.mouse.dblclick(box.x + box.width * fx, box.y + box.height * fy);
      await page.waitForTimeout(80);
      if (await page.locator('.float-win.logic-analyzer:not([hidden])').count()) return true;
    }
  }
  return false;
}

async function bootDemo(page: Page, id: string): Promise<void> {
  // Fresh page — avoid hash races with vite HMR / session restore
  await page.goto(`${base}/`, { waitUntil: 'load', timeout: 60_000 }).catch(async () => {
    await page.waitForSelector('#canvas', { timeout: 30_000 });
  });
  await page.waitForSelector('#canvas', { timeout: 30_000 });
  await dismissDialogs(page);
  await scrubUi(page);

  // Place Spectrum 48K
  await page.evaluate(() => {
    document.querySelector('.menu[data-menu="place"]')?.classList.add('open');
    (document.getElementById('add-spectrum') as HTMLButtonElement | null)?.click();
  });
  await page.locator('.float-win.machine-panel').waitFor({ state: 'attached', timeout: 20_000 });
  await dismissDialogs(page);
  await page.waitForTimeout(400);

  // Spectrum tab + load bundled demo
  await page.waitForFunction(() => {
    const sel = document.querySelector('[data-act="game-tab"], [data-act="game"]') as HTMLSelectElement | null;
    return !!sel && sel.options.length > 2;
  }, { timeout: 15_000 });
  await page.evaluate((demoId) => {
    document.querySelector('.demo-teach-overlay')?.remove();
    const tab = document.querySelector(
      '.machine-panel-tabs button[data-tab="spectrum"]',
    ) as HTMLButtonElement | null;
    tab?.click();
    const sel =
      (document.querySelector('[data-act="game-tab"]') as HTMLSelectElement | null) ??
      (document.querySelector('[data-act="game"]') as HTMLSelectElement | null);
    if (sel) {
      sel.value = demoId;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const btn =
      document.querySelector('[data-act="load-game-tab"]') ??
      document.querySelector('[data-act="load-game"]');
    (btn as HTMLButtonElement | null)?.click();
  }, id);
  await page.waitForTimeout(1200);
  await dismissDialogs(page);
  await scrubUi(page);
  await onlyMachinePanel(page);
  // Ensure machine Run is on
  await page.locator('.float-win.machine-panel [data-act="run"]').first().click({ force: true }).catch(() => undefined);
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  // ——— Logic analyzer ———
  await page.goto(`${base}/#e=lab-analyzer`);
  await page.waitForSelector('#canvas');
  await dismissDialogs(page);
  await scrubUi(page);
  const fit = page.locator('button', { hasText: 'fit' });
  if (await fit.count()) await fit.first().click();
  await page.waitForTimeout(400);
  // Ensure sim Run
  await page.locator('#sim-run, button#run').first().click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(600);
  await scrubUi(page);
  await shotPage(page, '39-lab-analyzer-circuit.png');
  // Also refresh classic 15-analyzer overview (no LA window)
  await shotPage(page, '15-analyzer.png');

  const opened = await openAnalyzerWindow(page);
  if (!opened) throw new Error('could not open Logic Analyzer window');
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('.float-win')) {
      if (!el.classList.contains('logic-analyzer')) el.hidden = true;
    }
    const la = document.querySelector<HTMLElement>('.float-win.logic-analyzer');
    if (la) {
      la.hidden = false;
      la.style.left = '60px';
      la.style.top = '50px';
      la.style.width = '680px';
      la.style.zIndex = '60';
    }
  });
  // Toggle button to create edges; wait for samples
  const box = await page.locator('#canvas').boundingBox();
  if (box) {
    // click near left toggles after fit
    await page.mouse.click(box.x + box.width * 0.28, box.y + box.height * 0.35);
    await page.waitForTimeout(200);
    await page.mouse.click(box.x + box.width * 0.28, box.y + box.height * 0.35);
  }
  await page.locator('.float-win.logic-analyzer button[data-act="clear"]').click({ force: true }).catch(() => undefined);
  // Free-run (no edge wait) so CLK pulses are visible in the shot
  await page.locator('.float-win.logic-analyzer select[data-act="trig-ch"]').selectOption({ index: 0 }).catch(() => undefined);
  await page.locator('.float-win.logic-analyzer button[data-act="run"]').click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(4500);
  await shotEl(page, '.float-win.logic-analyzer', '40-logic-analyzer-window.png');
  // Full page with LA + circuit (hide other floats)
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('.float-win')) {
      if (!el.classList.contains('logic-analyzer')) el.hidden = true;
    }
  });
  await shotPage(page, '41-analyzer-with-waveforms.png');

  // ——— Rainbow Spectrum (clean panel) ———
  await bootDemo(page, 'rainbow');
  await waitSpectrumPaint(page, 4, 25_000);
  await page.evaluate(() => {
    document.querySelector('.demo-teach-overlay')?.remove();
    const cons = document.querySelector<HTMLElement>('.machine-panel-pane[data-pane="console"]');
    const spec = document.querySelector<HTMLElement>('.machine-panel-pane[data-pane="spectrum"]');
    if (cons) cons.hidden = true;
    if (spec) spec.hidden = false;
    document.querySelectorAll('.machine-panel-tabs button').forEach((b) => {
      const btn = b as HTMLButtonElement;
      const on = btn.dataset.tab === 'spectrum';
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  });
  await onlyMachinePanel(page);
  await scrubUi(page);
  await page.waitForTimeout(400);
  await shotEl(page, '.float-win.machine-panel', '37-spectrum-machine.png');
  await onlyMachinePanel(page);
  await shotEl(page, '.float-win.machine-panel', '42-spectrum-panel.png');
  // Scroll media into view inside panel body
  await page.evaluate(() => {
    document.querySelector('.spec-media')?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(200);
  await shotEl(page, '.spec-media', '43-spectrum-media-bar.png');
  await shotEl(page, '.spec-computer-top', '44-spectrum-slots-nmi.png');

  await page.locator('.spec-debug').scrollIntoViewIfNeeded();
  await shotEl(page, '.spec-debug', '45-spectrum-debug.png');
  await page.locator('.spec-poke').scrollIntoViewIfNeeded();
  await shotEl(page, '.spec-poke', '46-spectrum-poke.png');
  await page.locator('.spec-tape').scrollIntoViewIfNeeded();
  await shotEl(page, '.spec-tape', '47-spectrum-tape.png');
  await page.locator('.spec-computer-controls').scrollIntoViewIfNeeded();
  await shotEl(page, '.spec-computer-controls', '48-spectrum-pad-keys.png');

  // Console tab — no teach overlay
  await page.evaluate(() => {
    document.querySelector('.demo-teach-overlay')?.remove();
    const cons = document.querySelector<HTMLElement>('.machine-panel-pane[data-pane="console"]');
    const spec = document.querySelector<HTMLElement>('.machine-panel-pane[data-pane="spectrum"]');
    if (cons && spec) {
      cons.hidden = false;
      spec.hidden = true;
    }
    document.querySelectorAll('.machine-panel-tabs button').forEach((b) => {
      const btn = b as HTMLButtonElement;
      const on = btn.dataset.tab === 'console';
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  });
  await page.waitForTimeout(300);
  await shotEl(page, '.machine-panel-pane[data-pane="console"]', '49-spectrum-console-load.png');

  // Demo dropdown list on Spectrum tab
  await page.evaluate(() => {
    document.querySelector('.demo-teach-overlay')?.remove();
    const cons = document.querySelector<HTMLElement>('.machine-panel-pane[data-pane="console"]');
    const spec = document.querySelector<HTMLElement>('.machine-panel-pane[data-pane="spectrum"]');
    if (cons) cons.hidden = true;
    if (spec) spec.hidden = false;
  });
  const demoSel = page.locator('select[data-act="game-tab"]');
  if (await demoSel.count()) {
    await demoSel.evaluate((sel: HTMLSelectElement) => {
      sel.size = Math.min(8, sel.options.length);
    });
    await page.waitForTimeout(200);
    await shotEl(page, '.spec-media', '51-spectrum-demo-list.png');
    await demoSel.evaluate((sel: HTMLSelectElement) => {
      sel.size = 0;
    });
  }

  // ——— GLAZX — wait until screen is actually painted ———
  await bootDemo(page, 'glazx');
  // TAP needs longer; require ≥3 colours (not just black+border)
  await waitSpectrumPaint(page, 3, 90_000);
  await onlyMachinePanel(page);
  await scrubUi(page);
  await page.waitForTimeout(500);
  await shotEl(page, '.float-win.machine-panel', '50-spectrum-demo-loaded.png');

  await browser.close();
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
