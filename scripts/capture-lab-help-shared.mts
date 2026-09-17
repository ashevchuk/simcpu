/**
 * Shared helpers for Lab-manual screenshot capture scripts.
 */
import type { Page } from '@playwright/test';

/** Hide floating UI chrome that should not appear in circuit shots. */
export async function scrubFloats(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('.float-win')) el.hidden = true;
    for (const el of document.querySelectorAll<HTMLElement>(
      '.z80-dialog-overlay, .z80-cheat, .sim-tutorial, .demo-teach-overlay',
    )) {
      el.hidden = true;
      el.remove();
    }
  });
}

/** Channel-route every wire on the active circuit, then fit the view. */
export async function tidyAndFit(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as unknown as { __simHelpCapture?: { tidyAll: () => number } }).__simHelpCapture;
    api?.tidyAll?.();
  });
  await page.waitForTimeout(120);
  const fit = page.locator('button', { hasText: 'fit' });
  if (await fit.count()) await fit.first().click();
  await page.waitForTimeout(350);
}

export async function dismissDialogs(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const ok = page.locator('.z80-dialog-overlay button.z80-dialog-primary, .z80-dialog button:has-text("OK")');
    if (await ok.count()) {
      await ok.first().click();
      await page.waitForTimeout(200);
    } else break;
  }
}
