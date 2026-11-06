/* global document, window, navigator, Event, KeyboardEvent, getComputedStyle, performance, requestAnimationFrame */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
try {
  for (const platform of ['MacIntel', 'Win32']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript((platform) => {
      Object.defineProperty(navigator, 'platform', { value: platform });
      window.puddleDesktop = {
        raiseWindow() {},
        onWindowFocusChange(callback) {
          window.hostFocus = callback;
          return () => {
            window.hostFocus = null;
          };
        },
      };
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
    for (const key of [modifier, 'Alt']) {
      await show();
      // macOS can retain modifier flags on a modifier's own key-up event.
      await page.evaluate(
        (key) =>
          window.dispatchEvent(
            new KeyboardEvent('keyup', {
              key,
              code: `${key}Left`,
              metaKey: true,
              ctrlKey: true,
              altKey: true,
            }),
          ),
        key,
      );
      await hidden();
      await page.keyboard.up('Slash');
      await page.keyboard.up('Alt');
      await page.keyboard.up(modifier);
    }
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
    const panel = await overlay.locator(':scope > div').evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        background: style.backgroundColor,
        border: style.borderWidth,
        shadow: style.boxShadow,
      };
    });
    assert.deepEqual(panel, { background: 'rgba(0, 0, 0, 0)', border: '0px', shadow: 'none' });
    await page.screenshot({ path: `/tmp/puddle-host-peek-${platform}.png` });
    await page.keyboard.up('Slash');
    await hidden();
    await page.keyboard.up('Alt');
    await page.keyboard.up(modifier);
    const refocus = async () => {
      await page.waitForTimeout(800); // a separate return, outside the focus burst
      await page.evaluate(() => {
        window.dispatchEvent(new Event('blur'));
        window.dispatchEvent(new Event('focus'));
      });
    };
    await refocus();
    assert.equal(await overlay.count(), 0); // opt-in
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await page.getByRole('switch', { name: /^Show host when returning to the window/ }).click();
    assert.deepEqual(
      await page.getByRole('switch').evaluateAll((switches) => switches.map((el) => el.id)),
      ['project-based-layout', 'show-all-project-sessions', 'reduce-motion', 'show-host-on-focus'],
    );
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('.monaco-editor textarea').first().focus();
    assert.equal(await overlay.count(), 0); // control focus is not window focus
    await page.waitForTimeout(800);
    const timing = await page.evaluate(async () => {
      window.dispatchEvent(new Event('blur'));
      const start = performance.now();
      window.dispatchEvent(new Event('focus'));
      let opened;
      let closed;
      let finalOpacity;
      while (performance.now() - start < 3000) {
        await new Promise(requestAnimationFrame);
        const el = document.querySelector('[data-host-peek]');
        if (el && !opened) {
          const style = getComputedStyle(el);
          opened = {
            animation: style.animationName,
            opacity: style.opacity,
            pointer: style.pointerEvents,
          };
        }
        if (el?.dataset.state === 'closed' && closed === undefined) {
          closed = performance.now() - start;
          // Finish the CSS animation before the removal timer to reproduce the
          // frame where the icon used to flash back to full opacity.
          for (const animation of el.getAnimations()) animation.finish();
          finalOpacity = getComputedStyle(el).opacity;
        }
        if (!el && opened)
          return { opened, closed, finalOpacity, removed: performance.now() - start };
      }
      throw new Error('Focus reminder did not finish');
    });
    assert.equal(timing.opened.pointer, 'none');
    if (platform === 'MacIntel') {
      assert.equal(timing.opened.animation, 'none');
      assert.equal(timing.opened.opacity, '1');
      assert.equal(timing.finalOpacity, '0');
      assert.ok(timing.closed >= 390 && timing.closed < 650, JSON.stringify(timing));
      assert.ok(timing.removed >= 510 && timing.removed < 850, JSON.stringify(timing));
    } else {
      assert.equal(timing.opened.animation, 'overlay-backdrop-appear');
      assert.equal(timing.closed, undefined);
      assert.ok(timing.removed >= 1190, JSON.stringify(timing));
    }
    assert.ok(await page.evaluate(() => document.activeElement.closest('.monaco-editor') !== null));
    await hidden(); // automatic timeout
    if (platform === 'MacIntel') {
      // Alternating native and renderer signals must not reset the debounce.
      // Keep the burst going beyond 750 ms to check the quiet period extends.
      for (let i = 0; i < 5; i++) {
        await page.waitForTimeout(i === 0 ? 50 : 180);
        await page.evaluate(() => {
          window.hostFocus(false);
          window.dispatchEvent(new Event('blur'));
          window.hostFocus(true);
          window.dispatchEvent(new Event('focus'));
        });
        assert.equal(await overlay.count(), 0);
      }
      await page.waitForTimeout(800);
      assert.equal(await overlay.count(), 0); // no trailing replay
    }
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
      window.hostFocus(false);
      window.hostFocus(true);
    });
    await overlay.waitFor(); // native focus works before Chromium catches up
    await page.evaluate(() => {
      delete document.hasFocus;
      window.hostFocus(false);
    });
    await hidden();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    assert.equal(await overlay.count(), 0); // the same activation burst is suppressed
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    assert.equal(await overlay.count(), 0); // duplicate focus cannot reopen it
    await refocus();
    await overlay.waitFor();
    await page.keyboard.press('ArrowRight');
    await hidden(); // input dismisses without losing editor focus
    assert.ok(await page.evaluate(() => document.activeElement.closest('.monaco-editor') !== null));
    await refocus();
    await overlay.waitFor();
    await show();
    await page.waitForTimeout(1400);
    assert.ok(await overlay.isVisible()); // shortcut takes over from the timed reminder
    await page.keyboard.up('Slash');
    await hidden();
    await page.keyboard.up('Alt');
    await page.keyboard.up(modifier);
    await refocus();
    await overlay.waitFor();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await hidden(); // click passes through and opens Settings
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await refocus();
    await overlay.waitFor(); // preference survives reload
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await page.getByRole('switch', { name: /^Show host when returning to the window/ }).click();
    await refocus();
    assert.equal(await overlay.count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'Host peek: Mac/Windows shortcuts, borderless overlay, focus reminder, input passthrough and persistence pass.',
  );
} finally {
  await browser.close();
}
