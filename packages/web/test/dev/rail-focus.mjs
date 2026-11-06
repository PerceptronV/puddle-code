/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(process.env.PREVIEW_URL ?? 'http://localhost:5174/');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const nav = page.getByRole('group', { name: 'Settings sections' });
  await nav.waitFor();
  // Freeze the opening scale, then change selection while the ancestor is transformed.
  await nav.evaluate((el) => {
    for (let parent = el; parent; parent = parent.parentElement) {
      for (const animation of parent.getAnimations()) {
        animation.pause();
        animation.currentTime = 20;
      }
    }
  });
  await nav.getByRole('button', { name: 'Profile', exact: true }).click({ force: true });
  await page.waitForTimeout(250);
  const selected = await nav.locator('[aria-current="page"]').boundingBox();
  const marker = await nav.locator('.control-tray-selection').boundingBox();
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(selected[key] - marker[key]) < 1.5, `Scaled selection ${key} aligns`);
  }
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('[data-path="README.md"]').dblclick();
  await page.locator('[data-path="package.json"]').dblclick();
  const tab = page.locator('[data-pane-tab]').filter({ hasText: 'README.md' });
  await tab.click();
  await page.mouse.move(700, 700);
  const tray = tab.locator('.pane-tab-controls');
  assert.equal(
    await tray.evaluate((el) => getComputedStyle(el).opacity),
    '0',
    'Mouse focus does not leave actions visible',
  );
  await page.keyboard.press('Tab');
  await tab.focus();
  assert.equal(
    await tray.evaluate((el) => getComputedStyle(el).opacity),
    '1',
    'Keyboard focus reveals actions',
  );
  await page.getByRole('button', { name: 'Hide sessions', exact: true }).click();
  const project = page.locator('.collapsed-session-project').first();
  const measure = async (density) => {
    await page.evaluate((value) => {
      document.documentElement.dataset.density = value;
    }, density);
    return project.evaluate((el) => ({
      font: getComputedStyle(el.querySelector('a')).fontSize,
      padding: parseFloat(getComputedStyle(el).paddingTop),
      gap: parseFloat(getComputedStyle(el).gap),
    }));
  };
  const comfortable = await measure('comfortable');
  const compact = await measure('compact');
  assert.equal(compact.font, comfortable.font);
  assert.ok(compact.padding > comfortable.padding);
  assert.equal(compact.gap, comfortable.gap);
  const abbreviation = project.locator('[data-project-abbreviation]');
  const initial = await abbreviation.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  for (const width of [24, 64]) {
    await project.evaluate((el, width) => {
      el.style.width = `${width}px`;
    }, width);
    await page.waitForTimeout(100);
    const fitted = await abbreviation.evaluate((el) => ({
      text: el.textContent,
      width: el.getBoundingClientRect().width,
      available: el.parentElement.getBoundingClientRect().width,
      font: parseFloat(getComputedStyle(el).fontSize),
      overflow: getComputedStyle(el.closest('a')).textOverflow,
    }));
    assert.equal(fitted.text, 'PUDDL');
    assert.ok(fitted.width <= fitted.available + 0.2, 'Full abbreviation fits the rail');
    assert.notEqual(fitted.overflow, 'ellipsis');
    if (width === 24) assert.ok(fitted.font < initial, 'Narrow rail shrinks the label');
    else assert.ok(fitted.font >= initial, 'Wider rail restores the natural size');
  }
  console.log(
    'Scaled settings selection, pointer/keyboard tab actions and compact rail labels/spacing pass.',
  );
} finally {
  await browser.close();
}
