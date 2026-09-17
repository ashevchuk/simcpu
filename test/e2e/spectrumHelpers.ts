/**
 * Shared Spectrum Playwright helpers (file:// and http Worker suites).
 */
import { expect, type Page } from '@playwright/test';

export async function placeSpectrum48(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelector('.menu[data-menu="place"]')?.classList.add('open');
    (document.getElementById('add-spectrum') as HTMLButtonElement | null)?.click();
  });
  await expect(page.locator('.float-win.machine-panel')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('canvas[data-canvas="spec"]')).toBeVisible();
}

export async function placeSpectrum128(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelector('.menu[data-menu="place"]')?.classList.add('open');
    (document.getElementById('add-spectrum128') as HTMLButtonElement | null)?.click();
  });
  await expect(page.locator('.float-win.machine-panel')).toBeVisible({ timeout: 15_000 });
}

export async function spectrumScreenActive(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const c = document.querySelector('canvas[data-canvas="spec"]') as HTMLCanvasElement | null;
    if (!c || c.width < 64 || c.height < 64) return false;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    // Full frame (incl. border) — blank white paper alone must not pass.
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const buckets = new Map<string, number>();
    let lit = 0;
    for (let i = 0; i < data.length; i += 32) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      if (r > 20 || g > 20 || b > 20) lit++;
      const key = `${r >> 5},${g >> 5},${b >> 5}`;
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    if (lit < 30) return false;
    if (buckets.size >= 2) return true;
    // Single near-white bucket = cleared Spectrum screen (the old broken rainbow).
    const only = [...buckets.keys()][0] ?? '';
    const [rq, gq, bq] = only.split(',').map(Number);
    const nearWhite = (rq ?? 0) >= 6 && (gq ?? 0) >= 6 && (bq ?? 0) >= 6;
    return !nearWhite;
  });
}

export async function loadBundledDemo(page: Page, id: string): Promise<void> {
  await page.evaluate((demoId) => {
    const sel =
      (document.querySelector('[data-act="game-tab"]') as HTMLSelectElement | null) ??
      (document.querySelector('[data-act="game"]') as HTMLSelectElement | null);
    if (sel) sel.value = demoId;
    const btn =
      document.querySelector('[data-act="load-game-tab"]') ??
      document.querySelector('[data-act="load-game"]');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, id);
}

export async function panelLog(page: Page): Promise<string> {
  return page.locator('.machine-panel-out').innerText();
}

export async function waitMenubar(page: Page): Promise<void> {
  await expect(page.locator('#menubar')).toBeVisible();
  await expect
    .poll(async () => page.evaluate(() => !!document.getElementById('add-spectrum')), {
      timeout: 10_000,
    })
    .toBe(true);
}
