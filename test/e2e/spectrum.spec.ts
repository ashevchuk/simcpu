/**
 * Soft Spectrum smoke: Place Spectrum, load bundled demos, assert screen activity.
 * Requires: npm run build:dist-file && npx playwright install chromium
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  placeSpectrum48,
  placeSpectrum128,
  spectrumScreenActive,
  loadBundledDemo,
  waitMenubar,
} from './spectrumHelpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const indexHtml = path.join(root, 'dist-file', 'index.html');

test.describe('Spectrum smoke', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`file://${indexHtml}`);
    await waitMenubar(page);
  });

  test('Place Spectrum boots 48K machine panel', async ({ page }) => {
    await placeSpectrum48(page);
    await expect(page.locator('[data-tab="spectrum"].is-active')).toBeVisible();
    await expect(page.locator('[data-spec-model]')).toContainText('48K');
  });

  test('Place Spectrum 128K boots machine panel', async ({ page }) => {
    await placeSpectrum128(page);
    await expect(page.locator('canvas[data-canvas="spec"]')).toBeVisible();
    await expect(page.locator('[data-spec-model]')).toContainText('128K');
    await page.locator('[data-act="mute"]').click();
    await expect(page.locator('[data-act="mute"]')).toContainText(/Mute|Unmute/);
  });

  test('#demo=rainbow loads SNA without Place click', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(`file://${indexHtml}#demo=rainbow`);
    await expect(page.locator('.float-win.machine-panel')).toBeVisible({ timeout: 25_000 });
    await expect(page.locator('#demo-teach-overlay')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.machine-panel-out')).toContainText(/rainbow/i, { timeout: 10_000 });
    await expect.poll(() => spectrumScreenActive(page), { timeout: 20_000 }).toBe(true);
  });

  test('rainbow SNA demo paints the screen', async ({ page }) => {
    test.setTimeout(60_000);
    await placeSpectrum48(page);
    await loadBundledDemo(page, 'rainbow');
    await expect.poll(() => spectrumScreenActive(page), { timeout: 20_000 }).toBe(true);
  });

  test('TAP demo auto LOAD "" shows screen activity', async ({ page }) => {
    test.setTimeout(90_000);
    await placeSpectrum48(page);
    await loadBundledDemo(page, 'glazx');
    await expect.poll(() => spectrumScreenActive(page), { timeout: 45_000 }).toBe(true);
  });
});
