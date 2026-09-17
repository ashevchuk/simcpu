/**
 * Capture menubar screenshots + rom-viewer.
 * Requires a loaded example so the canvas isn't empty IDLE.
 *
 *   HELP_BASE=http://127.0.0.1:4173 npx vite-node scripts/capture-lab-help-menus.mts
 */
import { chromium, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissDialogs, scrubFloats, tidyAndFit } from './capture-lab-help-shared.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src/assets/help');
const base = process.env.HELP_BASE || 'http://127.0.0.1:4173';

/** Refuse to keep near-blank full-page shots (empty IDLE canvas). */
function assertNotBlank(file: string, minBytes = 40_000): void {
  const st = fs.statSync(file);
  if (st.size < minBytes) {
    throw new Error(`refusing blank-looking shot ${path.basename(file)} (${st.size} bytes < ${minBytes})`);
  }
}

async function shotMenu(page: Page, menu: string, file: string): Promise<void> {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('.float-win')) el.hidden = true;
    for (const m of document.querySelectorAll('.menu')) m.classList.remove('open');
  });
  await page.locator(`.menu[data-menu="${menu}"] .menu-trigger`).click();
  await page.waitForSelector(
    `.menu[data-menu="${menu}"].open .menu-panel, .menu[data-menu="${menu}"].open .menu-item`,
    { state: 'visible', timeout: 5_000 },
  );
  await page.waitForTimeout(200);
  const dest = path.join(out, file);
  await page.screenshot({ path: dest });
  assertNotBlank(dest, 45_000);
  console.log(file);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
}

async function main(): Promise<void> {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  await page.goto(`${base}/#e=lab-counter-7seg`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('#canvas');
  await dismissDialogs(page);
  await scrubFloats(page);
  await tidyAndFit(page);

  await shotMenu(page, 'file', '30-menu-file.png');
  await shotMenu(page, 'place', '31-menu-place.png');
  await shotMenu(page, 'insert', '32-menu-insert.png');
  await shotMenu(page, 'edit', '33-menu-edit.png');
  await shotMenu(page, 'view', '34-menu-view.png');
  await shotMenu(page, 'help', '35-menu-help.png');
  await shotMenu(page, 'library', '36-menu-library.png');

  await page.goto(`${base}/#e=rom-viewer`, { waitUntil: 'load', timeout: 60_000 });
  await dismissDialogs(page);
  await scrubFloats(page);
  await tidyAndFit(page);
  await dismissDialogs(page);
  const dest38 = path.join(out, '38-rom-viewer.png');
  await page.screenshot({ path: dest38 });
  assertNotBlank(dest38, 50_000);
  console.log('38-rom-viewer');

  await browser.close();
  console.log('menus ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
