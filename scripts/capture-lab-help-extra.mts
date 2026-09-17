/**
 * Extra Soft Lab help shots (menus + lab-jk / reg8 / mux).
 *   HELP_BASE=http://127.0.0.1:4173 npx vite-node scripts/capture-lab-help-extra.mts
 */
import { chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissDialogs, scrubFloats, tidyAndFit } from './capture-lab-help-shared.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src/assets/help');
const base = process.env.HELP_BASE || 'http://127.0.0.1:5173';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(base);
  await page.waitForSelector('#canvas');

  await page.locator('.menu[data-menu="help"] .menu-trigger').click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(out, '22-help-menu.png') });
  console.log('22-help-menu');

  await page.locator('#help-lab-course').click();
  await page.waitForTimeout(300);
  await dismissDialogs(page);
  await page.screenshot({ path: path.join(out, '23-lab-course-panel.png') });
  console.log('23-lab-course-panel');

  await scrubFloats(page);

  await page.locator('.menu[data-menu="place"] .menu-trigger').click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(out, '24-place-menu.png') });
  console.log('24-place-menu');
  await page.keyboard.press('Escape');

  for (const [id, file] of [
    ['lab-jk', '25-jk-ff.png'],
    ['lab-reg8', '26-reg8.png'],
    ['lab-mux', '27-mux.png'],
  ] as const) {
    await page.goto(`${base}/#e=${id}`);
    await page.waitForTimeout(300);
    await dismissDialogs(page);
    await scrubFloats(page);
    await tidyAndFit(page);
    await page.screenshot({ path: path.join(out, file) });
    console.log(file);
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
