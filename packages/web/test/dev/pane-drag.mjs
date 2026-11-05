// Run against the daemon-free UI preview on localhost:5174.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:5174/');
  await page.locator('[data-path="README.md"]').dblclick();
  await page.locator('[data-path="package.json"]').dblclick();
  await page.waitForSelector('.monaco-editor');
  const handles = page.locator('[data-pane-drag-handle]');
  const drag = async (start, end) => {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 8, start.y, { steps: 3 });
    await page.mouse.move(end.x, end.y, { steps: 20 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.waitForTimeout(350);
  };
  const tab = await page
    .locator('[aria-roledescription="draggable"]')
    .filter({ hasText: 'package.json' })
    .boundingBox();
  const body = await page.locator('[data-editor-surface]').boundingBox();
  await drag(
    { x: tab.x + 30, y: tab.y + 15 },
    { x: body.x + body.width - 20, y: body.y + body.height / 2 },
  );
  assert.equal(await handles.count(), 2, 'tab edge drop splits');
  await handles.last().locator('[aria-roledescription="draggable"]').first().click();
  await page.locator('[data-path="HUMANS.md"]').dblclick();
  const ids = await handles.evaluateAll((els) => els.map((el) => el.dataset.paneDragHandle));
  const pane = page.locator(`[data-pane-drag-handle="${ids[1]}"]`);
  const start = await pane.boundingBox();
  const target = await page.locator('[data-editor-surface]').first().boundingBox();
  await drag(
    { x: start.x + start.width - 25, y: start.y + 15 },
    { x: target.x + target.width / 2, y: target.y + target.height / 2 },
  );
  assert.deepEqual(
    await handles.evaluateAll((els) => els.map((el) => el.dataset.paneDragHandle)),
    [ids[1], ids[0]],
    'whole panes swap',
  );
  assert.equal(
    await handles.first().locator('[aria-roledescription="draggable"]').count(),
    2,
    'all tabs preserved',
  );
  const moved = await handles.first().boundingBox();
  const other = await page.locator('[data-editor-surface]').last().boundingBox();
  await drag(
    { x: moved.x + moved.width - 25, y: moved.y + 15 },
    { x: other.x + other.width / 2, y: other.y + other.height - 15 },
  );
  const surfaces = await page.locator('[data-editor-surface]').all();
  const boxes = await Promise.all(surfaces.map((el) => el.boundingBox()));
  assert.ok(
    Math.abs(boxes[0].x - boxes[1].x) < 2 && boxes[1].y > boxes[0].y + 100,
    'edge drop stacks panes',
  );
  const order = await handles.evaluateAll((els) => els.map((el) => el.dataset.paneDragHandle));
  const last = await handles.last().boundingBox();
  await page.mouse.move(last.x + last.width - 25, last.y + 15);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width - 45, last.y + 60, { steps: 6 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.deepEqual(
    await handles.evaluateAll((els) => els.map((el) => el.dataset.paneDragHandle)),
    order,
    'escape cancels',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Tab split, whole-pane swap, all-tab preservation, edge move and Escape cancellation pass.',
  );
} finally {
  await browser.close();
}
