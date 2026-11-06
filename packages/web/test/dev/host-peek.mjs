/* global document, window, navigator, Event, getComputedStyle */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
try {
  for (const platform of ['MacIntel', 'Win32']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript((platform) => {
      Object.defineProperty(navigator, 'platform', { value: platform });
    }, platform);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(process.env.PREVIEW_URL ?? 'http://localhost:5174/');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('[data-path="package.json"]').dblclick();
    await page.locator('.monaco-editor textarea').first().focus();
    const modifier = platform === 'MacIntel' ? 'Meta' : 'Control';
    const overlay = page.locator('[data-host-peek]');
    const show = async () => {
      await page.keyboard.down(modifier);
      await page.keyboard.down('Alt');
      await page.keyboard.down('Slash');
      await overlay.waitFor();
      assert.match(await overlay.textContent(), /UI preview/);
      assert.ok(await overlay.locator('.lucide-server').isVisible());
    };
    const hidden = () => overlay.waitFor({ state: 'detached' });
    await show();
    await page.keyboard.down('Slash'); // autorepeat must keep it visible
    assert.ok(await overlay.isVisible());
    assert.ok(await page.evaluate(() => document.activeElement.closest('.monaco-editor') !== null));
    await page.keyboard.up('Slash');
    await hidden();
    await page.keyboard.up('Alt');
    await page.keyboard.up(modifier);
    await show();
    await page.keyboard.up('Alt');
    await hidden();
    await page.keyboard.up('Slash');
    await page.keyboard.up(modifier);
    await show();
    await page.keyboard.up(modifier);
    await hidden();
    await page.keyboard.up('Slash');
    await page.keyboard.up('Alt');
    await show();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await hidden();
    await page.keyboard.down('Slash'); // repeat after blur cannot reopen it
    assert.equal(await overlay.count(), 0);
    await page.keyboard.up('Slash');
    await page.keyboard.up('Alt');
    await page.keyboard.up(modifier);
    await show();
    await page.waitForTimeout(220);
    const appearance = await overlay.evaluate((el) => ({
      background: getComputedStyle(el).backgroundColor,
      blur: getComputedStyle(el).backdropFilter,
    }));
    assert.equal(appearance.background, 'rgba(0, 0, 0, 0)');
    assert.equal(appearance.blur, 'blur(8px)');
    assert.equal(
      await overlay
        .locator('.island-outline')
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      'rgba(0, 0, 0, 0)',
    );
    await page.screenshot({ path: `/tmp/puddle-host-peek-${platform}.png` });
    await page.keyboard.up('Slash');
    await hidden();
    await page.keyboard.up('Alt');
    await page.keyboard.up(modifier);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Host peek: Mac/Windows chords, repeats, key releases, blur and editor focus pass.');
} finally {
  await browser.close();
}
