import { chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const ok = page.locator('.z80-dialog-overlay button.z80-dialog-primary');
  if (await ok.count()) {
    await ok.first().click();
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: path.join(out, '23-lab-course-panel.png') });
  console.log('23-lab-course-panel');

  // hide floats
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('.float-win')) el.hidden = true;
  });

  await page.locator('.menu[data-menu="place"] .menu-trigger').click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(out, '24-place-menu.png') });
  console.log('24-place-menu');
  await page.keyboard.press('Escape');

  // Lab course next to latch for panel+circuit
  await page.goto(`${base}/#e=lab-jk`);
  await page.waitForTimeout(300);
  if (await ok.count()) {
    await ok.first().click();
    await page.waitForTimeout(400);
  }
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('.float-win, .z80-dialog-overlay')) el.hidden = true;
  });
  const fit = page.locator('button', { hasText: 'fit' });
  if (await fit.count()) await fit.first().click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(out, '25-jk-ff.png') });
  console.log('25-jk-ff');

  await page.goto(`${base}/#e=lab-reg8`);
  await page.waitForTimeout(300);
  if (await ok.count()) {
    await ok.first().click();
    await page.waitForTimeout(400);
  }
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('.float-win, .z80-dialog-overlay')) el.hidden = true;
  });
  if (await fit.count()) await fit.first().click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(out, '26-reg8.png') });
  console.log('26-reg8');

  await page.goto(`${base}/#e=lab-mux`);
  await page.waitForTimeout(300);
  if (await ok.count()) {
    await ok.first().click();
    await page.waitForTimeout(400);
  }
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('.float-win, .z80-dialog-overlay')) el.hidden = true;
  });
  if (await fit.count()) await fit.first().click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(out, '27-mux.png') });
  console.log('27-mux');

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
