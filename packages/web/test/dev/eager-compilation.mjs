/* global window */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.PREVIEW_URL ?? 'http://localhost:5174/');
  const mount = (failed = false) =>
    page.evaluate(async (failed) => {
      const { mountEagerCompilation } = await import('/test/dev/eager-compilation-fixture.tsx');
      window.eagerFixture = mountEagerCompilation(failed);
    }, failed);
  const state = () => page.evaluate(() => window.eagerFixture.state());
  await mount();
  await page.waitForFunction(() => window.eagerFixture.state().results.length === 1);
  assert.deepEqual((await state()).results, [{ revision: 10, pane: 'first' }]);
  await page.evaluate(() => window.eagerFixture.move());
  await page.waitForTimeout(100);
  assert.deepEqual(
    (await state()).modes,
    ['eager'],
    'Moving panes must not disable or re-register eager mode',
  );
  await page.evaluate(() => window.eagerFixture.externalEdit());
  await page.waitForFunction(() => window.eagerFixture.state().results.length === 2);
  assert.deepEqual((await state()).results[1], { revision: 11, pane: 'second' });
  // Models the first foreground status after idle eviction or daemon replacement.
  await page.evaluate(() => window.eagerFixture.expire());
  await page.waitForFunction(() => window.eagerFixture.state().results.length === 3);
  assert.deepEqual((await state()).results[2], { revision: 1, pane: 'second' });
  await page.waitForTimeout(1000);
  assert.deepEqual(
    (await state()).modes,
    ['eager', 'eager'],
    'A stale idle snapshot must not cause a registration loop',
  );
  await page.evaluate(() => window.eagerFixture.externalEdit());
  await page.waitForFunction(() => window.eagerFixture.state().results.length === 4);
  assert.deepEqual((await state()).results[3], { revision: 2, pane: 'second' });
  await page.evaluate(() => window.eagerFixture.remove());
  assert.deepEqual((await state()).modes, ['eager', 'eager', 'on_demand']);

  await mount(true);
  await page.waitForFunction(() => window.eagerFixture.state().failures.length > 0);
  await page.waitForTimeout(1000);
  assert.deepEqual((await state()).modes, ['eager'], 'Broken source must not loop registration');
  await page.evaluate(() => window.eagerFixture.externalEdit());
  await page.waitForFunction(() => window.eagerFixture.state().results.length === 1);
  assert.equal((await state()).results[0].revision, 11);
  await page.evaluate(() => window.eagerFixture.remove());
  assert.deepEqual(errors, []);
  console.log(
    'Eager compilation survives pane moves, recovers expired watchers and reset revisions, and observes fixes after a failed build.',
  );
} finally {
  await browser.close();
}
