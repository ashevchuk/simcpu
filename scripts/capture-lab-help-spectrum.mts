/**
 * Recapture Spectrum manual shots only (clean, painted).
 * HELP_BASE=http://127.0.0.1:4173 npx vite-node scripts/capture-lab-help-spectrum.mts
 */
import { chromium, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/assets/help');
const base = process.env.HELP_BASE || 'http://127.0.0.1:4173';

async function dismiss(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const ok = page.locator('.z80-dialog-overlay button.z80-dialog-primary');
    if (await ok.count()) {
      await ok.first().click();
      await page.waitForTimeout(200);
    } else break;
  }
  // Teach overlay "Got it"
  const got = page.locator('.demo-teach-overlay button, .demo-teach-card button');
  if (await got.count()) {
    await got.first().click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(200);
  }
  await page.evaluate(() => {
    document.querySelector('.demo-teach-overlay')?.remove();
    for (const tip of document.querySelectorAll<HTMLElement>('[data-spec-focus-tip], [data-spec-pause-tip]')) {
      tip.hidden = true;
      tip.style.display = 'none';
    }
  });
}

async function prepPanel(page: Page): Promise<void> {
  await dismiss(page);
  await page.evaluate(() => {
    document.querySelector('.demo-teach-overlay')?.remove();
    for (const tip of document.querySelectorAll<HTMLElement>('[data-spec-focus-tip], [data-spec-pause-tip]')) {
      tip.hidden = true;
      tip.style.display = 'none';
    }
    for (const el of document.querySelectorAll<HTMLElement>('.float-win')) {
      if (el.classList.contains('machine-panel')) {
        el.hidden = false;
        el.removeAttribute('hidden');
        el.style.left = '24px';
        el.style.top = '36px';
        el.style.width = '760px';
        el.style.height = '860px';
        el.style.zIndex = '50';
      } else {
        el.hidden = true;
      }
    }
    const cons = document.querySelector<HTMLElement>('.machine-panel-pane[data-pane="console"]');
    const spec = document.querySelector<HTMLElement>('.machine-panel-pane[data-pane="spectrum"]');
    if (cons) cons.hidden = true;
    if (spec) spec.hidden = false;
  });
}

async function shotClip(page: Page, sel: string, file: string): Promise<void> {
  const clip = await page.evaluate((selector) => {
    const n = document.querySelector(selector) as HTMLElement | null;
    if (!n) return null;
    n.hidden = false;
    n.removeAttribute('hidden');
    n.scrollIntoView({ block: 'nearest' });
    const r = n.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return {
      x: Math.max(0, r.x),
      y: Math.max(0, r.y),
      width: Math.min(r.width, 1400 - Math.max(0, r.x)),
      height: Math.min(r.height, 900 - Math.max(0, r.y)),
    };
  }, sel);
  if (!clip) throw new Error(`no clip ${sel}`);
  await page.screenshot({ path: path.join(out, file), clip });
  console.log(file);
}

/** Reject mostly-black / mostly-white screens. */
async function waitPainted(page: Page, minColours: number, ms: number): Promise<void> {
  const t0 = Date.now();
  let last = { colours: 0, lit: 0 };
  while (Date.now() - t0 < ms) {
    last = await page.evaluate(() => {
      const c = document.querySelector('canvas[data-canvas="spec"]') as HTMLCanvasElement | null;
      if (!c || c.width < 8) return { colours: 0, lit: 0 };
      const ctx = c.getContext('2d');
      if (!ctx) return { colours: 0, lit: 0 };
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      const buckets = new Set<string>();
      let lit = 0;
      for (let i = 0; i < data.length; i += 32) {
        const r = data[i]!;
        const g = data[i + 1]!;
        const b = data[i + 2]!;
        if (r > 40 || g > 40 || b > 40) lit++;
        buckets.add(`${r >> 5},${g >> 5},${b >> 5}`);
      }
      return { colours: buckets.size, lit };
    });
    // Need several colours AND enough non-near-black pixels (rejects solid black GLAZX wait)
    if (last.colours >= minColours && last.lit > 80) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`paint timeout colours=${last.colours} lit=${last.lit}`);
}

async function bootHash(page: Page, id: string): Promise<void> {
  await page.goto(`${base}/#demo=${id}`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('#canvas');
  await dismiss(page);
  await page.waitForTimeout(500);
  await dismiss(page);
  await prepPanel(page);
  await page.locator('.float-win.machine-panel [data-act="run"]').first().click({ force: true }).catch(() => undefined);
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  // Rainbow
  await bootHash(page, 'rainbow');
  await waitPainted(page, 4, 20_000);
  await dismiss(page);
  await prepPanel(page);
  await page.waitForTimeout(300);
  await shotClip(page, '.float-win.machine-panel', '37-spectrum-machine.png');
  await shotClip(page, '.float-win.machine-panel', '42-spectrum-panel.png');
  await shotClip(page, '.spec-media', '43-spectrum-media-bar.png');
  await shotClip(page, '.spec-computer-top', '44-spectrum-slots-nmi.png');
  await page.evaluate(() => document.querySelector('.spec-debug')?.scrollIntoView({ block: 'center' }));
  await shotClip(page, '.spec-debug', '45-spectrum-debug.png');
  await page.evaluate(() => document.querySelector('.spec-poke')?.scrollIntoView({ block: 'center' }));
  await shotClip(page, '.spec-poke', '46-spectrum-poke.png');
  await page.evaluate(() => document.querySelector('.spec-tape')?.scrollIntoView({ block: 'center' }));
  await shotClip(page, '.spec-tape', '47-spectrum-tape.png');
  await page.evaluate(() => document.querySelector('.spec-computer-controls')?.scrollIntoView({ block: 'center' }));
  await shotClip(page, '.spec-computer-controls', '48-spectrum-pad-keys.png');

  // Console tab (no toast)
  await page.evaluate(() => {
    document.querySelector('.demo-teach-overlay')?.remove();
    const cons = document.querySelector<HTMLElement>('.machine-panel-pane[data-pane="console"]');
    const spec = document.querySelector<HTMLElement>('.machine-panel-pane[data-pane="spectrum"]');
    if (cons) cons.hidden = false;
    if (spec) spec.hidden = true;
  });
  await page.waitForTimeout(200);
  await shotClip(page, '.machine-panel-pane[data-pane="console"]', '49-spectrum-console-load.png');

  // Demo list
  await page.evaluate(() => {
    const cons = document.querySelector<HTMLElement>('.machine-panel-pane[data-pane="console"]');
    const spec = document.querySelector<HTMLElement>('.machine-panel-pane[data-pane="spectrum"]');
    if (cons) cons.hidden = true;
    if (spec) spec.hidden = false;
  });
  const demoSel = page.locator('select[data-act="game-tab"]');
  await demoSel.evaluate((sel: HTMLSelectElement) => {
    sel.size = Math.min(8, sel.options.length);
  });
  await page.waitForTimeout(150);
  await shotClip(page, '.spec-media', '51-spectrum-demo-list.png');
  await demoSel.evaluate((sel: HTMLSelectElement) => {
    sel.size = 0;
  });

  // GLAZX — wait until really painted (not black)
  await bootHash(page, 'glazx');
  await waitPainted(page, 4, 120_000);
  await dismiss(page);
  await prepPanel(page);
  await page.waitForTimeout(400);
  await shotClip(page, '.float-win.machine-panel', '50-spectrum-demo-loaded.png');

  await browser.close();
  console.log('spectrum shots ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
