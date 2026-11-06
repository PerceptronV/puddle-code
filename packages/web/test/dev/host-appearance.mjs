/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.PREVIEW_URL ?? 'http://localhost:5174/');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('[data-path="package.json"]').dblclick();
  await page.locator('.monaco-editor').first().waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const nav = page.getByRole('group', { name: 'Settings sections' });
  await nav.getByRole('button', { name: 'Host', exact: true }).click();
  await page.getByRole('button', { name: 'Choose a host icon' }).click();
  assert.equal(await page.locator('[data-radix-popper-content-wrapper] button').count(), 64);
  await page.getByRole('button', { name: 'origami', exact: true }).click();
  await page.locator('header .lucide-origami').waitFor();
  const swatches = page.getByRole('group', { name: 'Host accent', exact: true });
  const luminance = (rgb) =>
    rgb
      .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4))
      .reduce((s, n, i) => s + n * [0.2126, 0.7152, 0.0722][i], 0);
  const rgb = (value) => {
    if (value.startsWith('#'))
      return [1, 3, 5].map((start) => parseInt(value.slice(start, start + 2), 16) / 255);
    const nums = value.match(/[\d.]+/g).map(Number);
    return value.startsWith('color(') ? nums.slice(0, 3) : nums.slice(0, 3).map((n) => n / 255);
  };
  const ratio = (a, b) => {
    const values = [luminance(rgb(a)), luminance(rgb(b))].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
  };
  for (const theme of ['light', 'dark']) {
    await page.evaluate(async (theme) => {
      const { applyTheme } = await import('/src/lib/appearance/theme.ts');
      applyTheme(theme);
    }, theme);
    const held = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return Object.fromEntries(
        [
          '--identity-navy',
          '--identity-gold',
          '--ansi-blue',
          '--ansi-green',
          '--status-running',
          '--status-waiting',
          '--paper',
        ].map((key) => [key, style.getPropertyValue(key)]),
      );
    });
    for (const colour of ['navy', 'gold', 'blue', 'green', 'red', 'violet', 'cyan']) {
      await swatches.getByRole('button', { name: colour, exact: true }).click();
      await page.waitForFunction(
        (colour) => document.documentElement.dataset.hostColour === colour,
        colour,
      );
      await page.waitForTimeout(250);
      const unchanged = await page.evaluate((keys) => {
        const style = getComputedStyle(document.documentElement);
        return Object.fromEntries(keys.map((key) => [key, style.getPropertyValue(key)]));
      }, Object.keys(held));
      assert.deepEqual(
        unchanged,
        held,
        'Explicit identity, semantic status, ANSI and document colours stay independent',
      );
      const styles = await page.evaluate(() => {
        const marker = document.querySelector(
          '[aria-label="Settings sections"] .control-tray-selection',
        );
        const selected = document.querySelector(
          '[aria-label="Settings sections"] [aria-current="page"]',
        );
        const identity = document.querySelector('header .host-identity');
        const header = document.querySelector('header');
        return {
          editor: getComputedStyle(document.querySelector('.monaco-editor-background'))
            .backgroundColor,
          palette: Object.fromEntries(
            [
              '--text-primary',
              '--text-secondary',
              '--text-muted',
              '--bg-base',
              '--bg-surface',
              '--bg-elevated',
              '--bg-tray',
              '--action',
              '--action-ink',
            ].map((key) => [
              key,
              getComputedStyle(document.documentElement).getPropertyValue(key).trim(),
            ]),
          ),
          selection: getComputedStyle(marker).backgroundColor,
          ink: getComputedStyle(selected).color,
          host: getComputedStyle(identity).color,
          surface: getComputedStyle(header).backgroundColor,
        };
      });
      assert.deepEqual(
        rgb(styles.editor),
        rgb(styles.palette['--bg-base']),
        `${theme}/${colour} Monaco follows the host palette`,
      );
      for (const foreground of ['--text-primary', '--text-secondary', '--text-muted']) {
        for (const background of ['--bg-base', '--bg-surface', '--bg-elevated', '--bg-tray']) {
          assert.ok(
            ratio(styles.palette[foreground], styles.palette[background]) >= 4.5,
            `${theme}/${colour} ${foreground} on ${background}`,
          );
        }
      }
      assert.ok(ratio(styles.palette['--action'], styles.palette['--action-ink']) >= 4.5);
      assert.ok(
        ratio(styles.selection, styles.ink) >= 4.5,
        `${theme}/${colour} selection contrast ${JSON.stringify(styles)}`,
      );
      assert.ok(
        ratio(styles.host, styles.surface) >= 4.5,
        `${theme}/${colour} host label contrast`,
      );
    }
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  await swatches.getByRole('button', { name: 'Default colour' }).click();
  await page.waitForFunction(() => !document.documentElement.dataset.hostColour);
  assert.equal(
    await page.evaluate(() => document.documentElement.style.getPropertyValue('--bg-base')),
    '',
  );
  await swatches.getByRole('button', { name: 'violet', exact: true }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: '/tmp/puddle-host-appearance.png' });
  assert.deepEqual(errors, []);
  console.log(
    'Host icon selection, accent propagation, reset, and all palette contrast checks passed.',
  );
} finally {
  await browser.close();
}
