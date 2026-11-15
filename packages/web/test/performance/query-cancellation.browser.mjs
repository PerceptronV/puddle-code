/* global window, document */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/performance-cancellation', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><div id="fixture"></div>',
    }),
  );
  await page.goto(`${process.env.PREVIEW_URL ?? 'http://localhost:5174'}/performance-cancellation`);
  await page.evaluate(async () => {
    const { mount } = await import('/test/performance/query-cancellation-fixture.ts');
    Object.assign(window, mount(document.getElementById('fixture')));
  });
  await page.waitForFunction(() => window.reads.length === 2);
  await page.evaluate(() => window.show(['old.ts'], 'old'));
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.reads.some((read) => read.aborted)), false);
  await page.evaluate(() => window.show(['new.ts'], 'new'));
  await page.waitForFunction(
    () => window.reads.length === 4 && window.reads.slice(0, 2).every((read) => read.aborted),
  );
  await page.evaluate(() => window.reads.find((read) => read.path.includes('new.ts')).finish());
  await page.getByText('fresh', { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => window.reads.slice(2).some((read) => read.aborted)),
    false,
  );
  await page.evaluate(() => window.show([], ''));
  await page.waitForFunction(
    () => window.reads.find((read) => read.path.includes('q=new')).aborted,
  );
  assert.deepEqual(errors, []);
  console.log(
    'Shared readers use one request; obsolete file/search reads cancel only after the last observer leaves; new reads complete.',
  );
} finally {
  await browser.close();
}
