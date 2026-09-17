/**
 * Capture Soft Lab help screenshots into src/assets/help/.
 * Usage (dev server already on :5173):
 *   npx playwright test scripts/capture-lab-help.mts --config=playwright.help.config.ts
 *
 * Or: npx vite-node scripts/capture-lab-help.mts  (uses playwright chromium)
 */
import { chromium, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src/assets/help');
const base = process.env.HELP_BASE || 'http://127.0.0.1:5173';

async function prep(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('.float-win')) el.hidden = true;
    for (const el of document.querySelectorAll<HTMLElement>('.z80-dialog-overlay, .z80-cheat, .sim-tutorial')) {
      el.hidden = true;
      el.remove();
    }
  });
  await page.waitForTimeout(200);
  const fit = page.locator('button', { hasText: 'fit' });
  if (await fit.count()) await fit.first().click();
  await page.waitForTimeout(350);
}

async function loadExample(page: Page, id: string): Promise<void> {
  await page.goto(`${base}/#e=${id}`);
  await page.waitForTimeout(300);
  const ok = page.locator('.z80-dialog-overlay button.z80-dialog-primary, .z80-dialog button:has-text("OK")');
  if (await ok.count()) {
    await ok.first().click();
    await page.waitForTimeout(400);
  }
  // Alerts after some tutorials
  for (let i = 0; i < 3; i++) {
    const alertOk = page.locator('.z80-dialog-overlay button.z80-dialog-primary');
    if (await alertOk.count()) {
      await alertOk.first().click();
      await page.waitForTimeout(250);
    } else break;
  }
  await prep(page);
}

async function shot(page: Page, name: string): Promise<void> {
  const dest = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: dest, type: 'png' });
  console.log('wrote', path.relative(root, dest));
}

async function openLibrary(page: Page): Promise<void> {
  await page.locator('#library-menu-trigger, .menu[data-menu="library"] .menu-trigger').first().click();
  await page.waitForTimeout(250);
}

async function main(): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  // Fresh chrome
  await page.goto(base + '/');
  await page.waitForSelector('#canvas');
  await prep(page);
  await shot(page, '01-chrome-soft-lab');

  await openLibrary(page);
  await shot(page, '02-library-lab-filter');
  await page.keyboard.press('Escape');
  await prep(page);

  await loadExample(page, 'cmos-inverter');
  await shot(page, '03-cmos-inverter');

  await loadExample(page, 'and-gate');
  await shot(page, '04-and-gate-chip');
  // Dive into chip
  await page.evaluate(() => {
    const canvas = document.getElementById('canvas') as HTMLCanvasElement;
    const r = canvas.getBoundingClientRect();
    // dblclick center-ish where chip usually sits after fit
    const x = r.left + r.width * 0.45;
    const y = r.top + r.height * 0.45;
    for (const type of ['mousemove', 'dblclick'] as const) {
      canvas.dispatchEvent(
        new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, buttons: 1 }),
      );
    }
  });
  await page.waitForTimeout(500);
  // Confirm fork dialog if any
  const forkOk = page.locator('.z80-dialog-overlay button.z80-dialog-primary');
  if (await forkOk.count()) {
    // Prefer Cancel/keep shared if Cancel exists for fork — click primary OK for dive
    await forkOk.first().click();
    await page.waitForTimeout(400);
  }
  await prep(page);
  await shot(page, '05-chip-dive-internals');

  await loadExample(page, 'd-latch');
  await shot(page, '06-d-latch');

  await loadExample(page, 'lab-counter-7seg');
  await shot(page, '07-counter-7seg-soft');

  // Soft Lab off
  await page.locator('#sim-soft-lab').click();
  await page.waitForTimeout(600);
  await prep(page);
  await shot(page, '08-counter-soft-off');
  await page.locator('#sim-soft-lab').click(); // back on
  await page.waitForTimeout(400);

  await loadExample(page, 'lab-adder4');
  await shot(page, '09-adder-bus-switch');

  await loadExample(page, 'lab-alu4');
  await shot(page, '10-alu4');

  await loadExample(page, 'lab-buf8-oe');
  await shot(page, '11-buf8-oe');

  await loadExample(page, 'lab-contend-bus');
  await shot(page, '12-contend-bus');

  await loadExample(page, 'lab-soft-ram');
  await shot(page, '13-soft-ram');

  await loadExample(page, 'lab-mini-cpu');
  await shot(page, '14-mini-cpu');

  await loadExample(page, 'lab-analyzer');
  await shot(page, '15-analyzer');

  await loadExample(page, 'lab-sipo');
  await shot(page, '16-sipo');

  await loadExample(page, 'lab-decoder');
  await shot(page, '17-decoder');

  await loadExample(page, 'nand-gate');
  await shot(page, '18-nand-gate');

  await loadExample(page, 'half-adder');
  await shot(page, '19-half-adder');

  await loadExample(page, 'xor-pulse');
  await shot(page, '20-xor-pulse');

  // Wire tool active on a simple circuit for routing/junction context
  await loadExample(page, 'cmos-inverter');
  await page.locator('[data-tool="wire"]').click();
  await page.waitForTimeout(200);
  await prep(page);
  await shot(page, '21-wire-tool-ready');

  await browser.close();
  console.log('done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
