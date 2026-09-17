/**
 * Visual smoke: load the file:// dist build and assert the canvas paints.
 * Also loads a non-Spectrum example (D-latch) via Help menu.
 * Requires: npm run build:dist-file && npx playwright install chromium
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const indexHtml = path.join(root, 'dist-file', 'index.html');

async function canvasPainted(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => {
    const c = document.getElementById('canvas') as HTMLCanvasElement | null;
    if (!c) return false;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, Math.min(c.width, 64), Math.min(c.height, 64));
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 0) return true;
    }
    return false;
  });
}

test.describe('schematic smoke', () => {
  test('canvas renders menubar and non-empty pixels', async ({ page }) => {
    await page.goto(`file://${indexHtml}`);
    await expect(page.locator('#menubar')).toBeVisible();
    await expect(page.locator('#canvas')).toBeVisible();
    await page.waitForTimeout(400);
    expect(await canvasPainted(page)).toBe(true);
  });

  test('Help → Tutorial (lab counter) loads Counter + 7-seg', async ({ page }) => {
    await page.goto(`file://${indexHtml}`);
    await expect(page.locator('#menubar')).toBeVisible();
    await page.waitForTimeout(400);

    await page.evaluate(() => {
      document.querySelector('.menu[data-menu="help"]')?.classList.add('open');
      (document.getElementById('help-tutorial-lab') as HTMLButtonElement | null)?.click();
    });

    await expect(page.locator('.z80-dialog-overlay')).toBeVisible({ timeout: 10_000 });
    await page.locator('.z80-dialog-overlay button.z80-dialog-primary').click();

    await expect(page.locator('.z80-dialog-overlay')).toBeVisible({ timeout: 10_000 });
    await page.locator('.z80-dialog-overlay button.z80-dialog-primary').click();

    await page.waitForTimeout(600);
    expect(await canvasPainted(page)).toBe(true);
    await expect(page.locator('#sim-soft-lab')).toHaveClass(/active/);
  });
});
