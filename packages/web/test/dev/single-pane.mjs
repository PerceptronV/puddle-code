/* global document, getComputedStyle, DataTransfer */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.PREVIEW_URL ?? 'http://localhost:5174/');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('[data-path="README.md"]').click();
  const edge = page.locator('[data-pane-single-edge]');
  await edge.waitFor();
  assert.ok((await edge.boundingBox()).height < 12);
  await edge.locator('[data-pane-tab]').hover({ position: { x: 150, y: 3 } });
  await page.getByRole('tooltip').filter({ hasText: 'README.md' }).waitFor();
  assert.equal(await edge.locator('.pane-single-tab > .truncate').count(), 0);
  const sourceButton = edge.getByRole('button', { name: /^Source/ });
  await sourceButton.hover();
  const trayBox = await edge.locator('.pane-tab-controls').boundingBox();
  const edgeBox = await edge.boundingBox();
  assert.ok(trayBox.y >= edgeBox.y + 4, 'Floating tray stays below the pane top edge');
  await page.screenshot({ path: '/tmp/puddle-pane-tray-visible.png' });

  const sourceTooltip = page.getByRole('tooltip').filter({ hasText: /^Source/ });
  await sourceTooltip.waitFor();
  const tipBox = await sourceTooltip.boundingBox();
  const buttonBox = await sourceButton.boundingBox();
  assert.ok(tipBox.y >= buttonBox.y + buttonBox.height, 'Source tooltip clears the floating tray');
  assert.ok(
    tipBox.x >= 0 && tipBox.x + tipBox.width <= 1440,
    'Source tooltip stays inside the viewport',
  );
  assert.equal(await sourceButton.getAttribute('title'), null);

  const surface = page.locator('[data-editor-surface]');
  const singleHeight = (await surface.boundingBox()).height;
  await page.locator('[data-path="package.json"]').click();
  await edge.waitFor({ state: 'detached' });
  const strip = page.locator('[data-pane-drag-handle]');
  assert.equal(await strip.locator('[data-pane-tab]').count(), 2);
  assert.ok((await surface.boundingBox()).height < singleHeight - 20);
  await strip.locator('[data-pane-tab]').filter({ hasText: 'package.json' }).hover();
  await page.getByRole('button', { name: 'Close package.json', exact: true }).click();
  await edge.waitFor();

  // A real native file-transfer event goes through the pane's capture listener.
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await page
    .locator('[data-path="HUMANS.md"]')
    .dispatchEvent('dragstart', { dataTransfer: transfer });
  const bounds = await surface.boundingBox();
  const event = {
    dataTransfer: transfer,
    clientX: bounds.x + bounds.width / 2,
    clientY: bounds.y + bounds.height / 2,
  };
  await surface.dispatchEvent('dragover', event);
  await surface.dispatchEvent('drop', event);
  await edge.waitFor({ state: 'detached' });
  assert.equal(await strip.locator('[data-pane-tab]').count(), 2);
  await strip.locator('[data-pane-tab]').filter({ hasText: 'HUMANS.md' }).hover();
  await page.getByRole('button', { name: 'Close HUMANS.md', exact: true }).click();
  await edge.waitFor();
  await page.mouse.move(1000, 800);
  await page.screenshot({ path: '/tmp/puddle-single-pane.png' });

  // Hover moves between rows rather than creating independent local fills.
  const checkHover = async () => {
    const list = page
      .locator('.session-hover-list')
      .filter({ has: page.locator('[data-session-hover]') })
      .first();
    const rows = list.locator('[data-session-hover]');
    await rows.nth(0).hover();
    await page.waitForTimeout(180);
    const marker = list.locator('.session-hover-surface');
    const before = (await marker.boundingBox()).y;
    await rows.nth(1).hover();
    assert.ok(
      await marker.evaluate((el) =>
        el
          .getAnimations()
          .some((animation) => animation.effect.getKeyframes().some((frame) => frame.transform)),
      ),
      'Session hover slides',
    );
    await page.waitForTimeout(180);
    assert.ok(Math.abs((await marker.boundingBox()).y - before) > 5);
    assert.ok(
      await marker.evaluate(
        (el) =>
          +getComputedStyle(el).zIndex <
          +getComputedStyle(el.parentElement.querySelector('[data-session-hover]')).zIndex,
      ),
    );
  };
  await checkHover();
  await page.getByRole('button', { name: 'Hide sessions', exact: true }).click();
  await page.waitForFunction(
    () => !document.documentElement.classList.contains('sidebar-transition'),
  );
  await checkHover();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.documentElement.dataset.reduceMotion === 'true');
  assert.equal(
    await page
      .locator('.collapsed-session-list .session-hover-surface')
      .evaluate((el) => getComputedStyle(el).transitionDuration),
    '0s',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Single-tab edge/path tooltip, second open, native file drop, return to full pane, and expanded/collapsed session hover pass.',
  );
} finally {
  await browser.close();
}
