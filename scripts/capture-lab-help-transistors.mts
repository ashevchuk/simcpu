/**
 * Recapture help screenshots that show raw transistors (new MOSFET glyphs).
 *   npm run build:dist-file && npx --yes serve dist-file -l 4173
 *   HELP_BASE=http://127.0.0.1:4173 npx vite-node scripts/capture-lab-help-transistors.mts
 */
import { chromium, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissDialogs, scrubFloats, tidyAndFit } from './capture-lab-help-shared.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src/assets/help');
const base = process.env.HELP_BASE || 'http://127.0.0.1:4173';

async function prep(page: Page): Promise<void> {
  await scrubFloats(page);
  await tidyAndFit(page);
}

async function loadExample(page: Page, id: string): Promise<void> {
  await page.goto(`${base}/#e=${id}`);
  await page.waitForTimeout(400);
  await dismissDialogs(page);
  await prep(page);
}

async function shot(page: Page, name: string): Promise<void> {
  const dest = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: dest, type: 'png' });
  console.log('wrote', path.relative(root, dest));
}

async function main(): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  await page.goto(base + '/');
  await page.waitForSelector('#canvas');

  await loadExample(page, 'cmos-inverter');
  await shot(page, '03-cmos-inverter');
  await shot(page, 'help-lab-course-cmos');

  await loadExample(page, 'and-gate');
  await page.evaluate(() => {
    const canvas = document.getElementById('canvas') as HTMLCanvasElement;
    const r = canvas.getBoundingClientRect();
    const x = r.left + r.width * 0.45;
    const y = r.top + r.height * 0.45;
    for (const type of ['mousemove', 'dblclick'] as const) {
      canvas.dispatchEvent(
        new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, buttons: 1 }),
      );
    }
  });
  await page.waitForTimeout(500);
  const forkOk = page.locator('.z80-dialog-overlay button.z80-dialog-primary');
  if (await forkOk.count()) {
    await forkOk.first().click();
    await page.waitForTimeout(400);
  }
  await prep(page);
  await shot(page, '05-chip-dive-internals');

  await loadExample(page, 'lab-counter-7seg');
  await page.locator('#sim-soft-lab').click();
  await page.waitForTimeout(600);
  await prep(page);
  await shot(page, '08-counter-soft-off');
  await page.locator('#sim-soft-lab').click();
  await page.waitForTimeout(200);
  await loadExample(page, 'nand-gate');
  await shot(page, '18-nand-gate');

  await loadExample(page, 'xor-pulse');
  await shot(page, '20-xor-pulse');

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
