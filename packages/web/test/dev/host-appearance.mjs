/* global document, window, navigator, getComputedStyle, Event */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.PREVIEW_URL ?? 'http://localhost:5174/');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('[data-path="README.md"]').dblclick();
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
    await swatches.getByRole('button', { name: 'Default colour' }).click();
    await page.waitForFunction(() => !document.documentElement.dataset.hostColour);
    const defaults = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return ['--bg-surface', '--bg-pane', '--bg-elevated', '--bg-tray'].map((key) =>
        style.getPropertyValue(key).trim(),
      );
    });
    assert.equal(defaults[0], defaults[1], `${theme} default pane/sidebar mapping`);
    assert.equal(defaults[2], defaults[3], `${theme} default nested/elevated mapping`);
    const held = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return Object.fromEntries(
        [
          '--identity-default',
          '--identity-navy',
          '--identity-gold',
          '--ansi-blue',
          '--ansi-green',
          '--status-running',
          '--status-waiting',
          '--paper',
          '--bg-base',
        ].map((key) => [key, style.getPropertyValue(key)]),
      );
    });
    for (const colour of [
      'navy',
      'gold',
      'blue',
      'green',
      'red',
      'violet',
      'cyan',
      '#000000',
      '#ffffff',
      '#ff00ff',
      '#12a6bc',
      '#157a50',
      '#f2fff9',
      '#040d09',
    ]) {
      if (colour.startsWith('#')) {
        await swatches.locator('input[type="color"]').evaluate((input, colour) => {
          input.value = colour;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }, colour);
      } else {
        await swatches.getByRole('button', { name: colour, exact: true }).click();
      }
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
      const styles = await page.evaluate(async () => {
        const marker = document.querySelector(
          '[aria-label="Settings sections"] .control-tray-selection',
        );
        const selected = document.querySelector(
          '[aria-label="Settings sections"] [aria-current="page"]',
        );
        const identity = document.querySelector('header .host-identity');
        const header = document.querySelector('header');
        const { xtermThemeFromCss } = await import('/src/lib/appearance/theme.ts');
        return {
          surfaceOverrides: ['--bg-base', '--bg-pane', '--bg-tray'].map((key) =>
            document.documentElement.style.getPropertyValue(key),
          ),
          terminal: xtermThemeFromCss().background,
          pane: getComputedStyle(document.querySelector('.workspace-pane')).backgroundColor,
          sidebar: getComputedStyle(document.querySelector('.workspace-surface.bg-surface'))
            .backgroundColor,
          activeTab: getComputedStyle(document.querySelector('[data-pane-tab].bg-ground'))
            .backgroundColor,
          editor: getComputedStyle(document.querySelector('.monaco-editor-background'))
            .backgroundColor,
          palette: Object.fromEntries(
            [
              '--text-primary',
              '--text-secondary',
              '--text-muted',
              '--bg-base',
              '--bg-surface',
              '--bg-pane',
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
      assert.deepEqual(
        styles.surfaceOverrides,
        ['', '', ''],
        `${theme}/${colour} accents preserve shared surface aliases and reading backgrounds`,
      );
      assert.equal(
        styles.palette['--bg-pane'],
        styles.palette['--bg-surface'],
        `${theme}/${colour} pane frames match sidebar surfaces`,
      );
      for (const foreground of ['--text-primary', '--text-secondary', '--text-muted']) {
        for (const background of [
          '--bg-base',
          '--bg-surface',
          '--bg-pane',
          '--bg-elevated',
          '--bg-tray',
        ]) {
          assert.ok(
            ratio(styles.palette[foreground], styles.palette[background]) >= 4.5,
            `${theme}/${colour} ${foreground} on ${background}`,
          );
        }
      }
      assert.deepEqual(
        rgb(styles.editor),
        rgb(held['--bg-base']),
        `${theme}/${colour} reading surface keeps the default theme`,
      );
      assert.deepEqual(rgb(styles.terminal), rgb(held['--bg-base']));
      assert.deepEqual(rgb(styles.activeTab), rgb(styles.editor));
      assert.deepEqual(rgb(styles.pane), rgb(styles.sidebar));
      const baseLight = luminance(rgb(styles.palette['--bg-base']));
      const surfaceLight = luminance(rgb(styles.palette['--bg-surface']));
      const trayLight = luminance(rgb(styles.palette['--bg-tray']));
      assert.ok(
        theme === 'dark'
          ? baseLight < surfaceLight && surfaceLight < trayLight
          : baseLight > surfaceLight && surfaceLight > trayLight,
        `${theme}/${colour} islands and nested trays step away from the reading surface`,
      );
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
    await swatches.getByRole('button', { name: 'blue', exact: true }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await nav.waitFor({ state: 'hidden' });
    await page.screenshot({ path: `/private/tmp/puddle-islands-${theme}.png` });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await nav.getByRole('button', { name: 'Host', exact: true }).click();
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
  await swatches.getByRole('button', { name: 'blue', exact: true }).click();
  const hostPicker = swatches.locator('input[type="color"]');
  await hostPicker.evaluate((input) => {
    input.click = () => {
      input.dataset.opened = 'true';
    };
  });
  await swatches.getByRole('button', { name: 'Custom host accent', exact: true }).click();
  const selectedBlue = await page.evaluate(() => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--ansi-blue').trim();
    return raw.toLowerCase();
  });
  assert.equal(await hostPicker.inputValue(), selectedBlue);
  assert.equal(await hostPicker.getAttribute('data-opened'), 'true');
  await hostPicker.evaluate((input) => {
    input.value = '#12a6bc';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => document.documentElement.dataset.hostColour === '#12a6bc');
  await swatches.getByRole('button', { name: 'Custom host accent', exact: true }).click();
  assert.equal(await hostPicker.inputValue(), '#12a6bc');
  await nav.getByRole('button', { name: 'Profile', exact: true }).click();
  const profileColours = page.getByRole('group', { name: 'Icon colour', exact: true });
  await profileColours.getByRole('button', { name: 'green', exact: true }).click();
  const profilePicker = profileColours.locator('input[type="color"]');
  await profilePicker.evaluate((input) => {
    input.click = () => {};
  });
  await profileColours.getByRole('button', { name: 'Custom icon colour', exact: true }).click();
  const selectedGreen = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--ansi-green').trim(),
  );
  assert.equal(await profilePicker.inputValue(), selectedGreen);
  await profilePicker.evaluate((input) => {
    input.value = '#ad3768';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(
    () => document.querySelector('.profile-trigger svg')?.style.color === 'rgb(173, 55, 104)',
  );
  await profileColours.getByRole('button', { name: 'Custom icon colour', exact: true }).click();
  assert.equal(await profilePicker.inputValue(), '#ad3768');
  await nav.getByRole('button', { name: 'Host', exact: true }).click();
  await swatches.getByRole('button', { name: 'violet', exact: true }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: '/tmp/puddle-host-appearance.png' });
  // Exercise the native macOS header branch, including its traffic-light inset.
  const mac = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await mac.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    window.puddleDesktop = {
      raiseWindow() {},
      isFullScreen: async () => false,
      onFullScreenChange(callback) {
        window.setPreviewFullScreen = callback;
        return () => {};
      },
    };
  });
  await mac.goto(process.env.PREVIEW_URL ?? 'http://localhost:5174/');
  await mac.getByRole('button', { name: 'Close', exact: true }).click();
  const macHeader = mac.locator('header.host-header');
  assert.equal(await macHeader.evaluate((el) => getComputedStyle(el).paddingLeft), '84px');
  assert.ok(await macHeader.locator('.lucide-server').isVisible());
  await mac.getByRole('button', { name: 'Settings', exact: true }).click();
  await mac
    .getByRole('group', { name: 'Settings sections' })
    .getByRole('button', { name: 'Host', exact: true })
    .click();
  await mac.getByRole('button', { name: 'Choose a host icon' }).click();
  await mac.getByRole('button', { name: 'origami', exact: true }).click();
  await mac.getByRole('button', { name: 'Close', exact: true }).click();
  assert.ok(await macHeader.locator('.lucide-origami').isVisible());
  await mac.evaluate(() => window.setPreviewFullScreen(true));
  await mac.waitForFunction(
    () => getComputedStyle(document.querySelector('header.host-header')).paddingLeft === '0px',
  );
  assert.ok(await macHeader.locator('.lucide-origami').isVisible());
  await mac.close();
  assert.deepEqual(errors, []);
  console.log(
    'Host icon selection, accent propagation, reset, and all palette contrast checks passed.',
  );
} finally {
  await browser.close();
}
