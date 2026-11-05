/* global document, getComputedStyle -- evaluated in the isolated browser */
// Run with the daemon-free preview server already listening on localhost:5174.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => {
    errors.push(e.message);
    console.log('BROWSER ERROR', e.message);
  });

  await page.goto(process.env.PREVIEW_URL ?? 'http://localhost:5174/');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('group', { name: 'Workspace controls' }).waitFor();
  const actionTray = page.getByRole('group', { name: 'Workspace controls' });
  assert.equal(
    await actionTray.evaluate((el) => getComputedStyle(el).backgroundColor),
    'rgba(0, 0, 0, 0)',
  );
  assert.equal(
    await actionTray
      .locator('button')
      .nth(1)
      .evaluate((el) => getComputedStyle(el, '::before').content),
    'none',
  );
  await page.locator('[data-path="README.md"]').dblclick();
  await page.waitForSelector('.puddle-hidden-diff-controller', { state: 'attached' });
  for (const width of [760, 1440, 760, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(
      (n) => document.querySelectorAll('.control-tray-vertical').length === n,
      width === 760 ? 2 : 0,
    );
    await page.waitForFunction(
      (count) => document.querySelectorAll('.puddle-hidden-diff-controller').length === count,
      width === 760 ? 0 : 1,
    );
  }
  assert.deepEqual(errors, []);
  console.log('Repeated editor teardown at responsive breakpoints passes.');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByPlaceholder('Search files and contents').fill('App');
  await page
    .locator('button[title="packages/web/src/App.tsx"] img[src$="react_ts.svg"]')
    .first()
    .waitFor();
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await page
    .locator('button[title="packages/web/src/App.tsx"] img[src$="react_ts.svg"]')
    .first()
    .waitFor();
  await page.getByRole('button', { name: 'Worktrees', exact: true }).click();
  await page.getByText('clone', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.locator('[data-path="examples"]').click();
  await page.locator('[data-path="examples/preview.ipynb"]').dblclick();
  await page
    .locator('[aria-roledescription="draggable"]')
    .filter({ has: page.locator('img[src$="jupyter.svg"]') })
    .hover();
  await page.getByRole('button', { name: 'Show notebook', exact: true }).click();
  await page.getByRole('group', { name: 'Add notebook cells' }).waitFor();
  await page.getByRole('button', { name: 'Add Markdown cell', exact: true }).click();

  await page.locator('[data-path="examples/preview.pdf"]').dblclick();
  const zoomTray = page.getByRole('group', { name: 'PDF zoom' });
  await zoomTray.waitFor();
  const pdfBounds = await page.getByRole('region', { name: 'PDF document' }).boundingBox();
  const trayBounds = await zoomTray.boundingBox();
  assert.ok(
    trayBounds.y >= pdfBounds.y &&
      trayBounds.y + trayBounds.height <= pdfBounds.y + pdfBounds.height &&
      trayBounds.x >= pdfBounds.x &&
      trayBounds.x + trayBounds.width <= pdfBounds.x + pdfBounds.width,
    'PDF zoom tray stays inside the visible document viewport',
  );
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();

  assert.deepEqual(errors, []);
  console.log(
    'Search/Changes icons, worktree rows, notebook add-cell tray and PDF zoom tray pass.',
  );
} finally {
  await browser.close();
}
