import { inspectNode, chooseHuddleOption } from './helpers/controls.mjs';
/* global window */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(
    new URL('/test/huddle/fixture.html', process.env.PREVIEW_URL ?? 'http://localhost:5174/').href,
  );
  await page.waitForFunction(() => !!window.huddleFixture);
  await page.evaluate(() => window.huddleFixture.releaseProjects());
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByRole('button', { name: 'Review graph', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Huddle editor' });
  await editor.getByRole('button', { name: 'Add node', exact: true }).click();
  await editor.getByRole('button', { name: 'Add Interval', exact: true }).click();
  await editor.getByRole('button', { name: 'Add node', exact: true }).click();
  await inspectNode(editor.getByRole('button', { name: 'Interval event', exact: true }));
  const inspector = editor.getByRole('complementary', { name: 'Node inspector' });
  const interval = inspector.getByRole('group', { name: 'Interval (milliseconds)', exact: true });
  assert.equal(await interval.getByRole('spinbutton').inputValue(), '60000');
  await interval.getByRole('spinbutton').fill('1000');
  await interval.getByRole('button', { name: 'Apply setting' }).click();
  const missed = inspector.getByRole('group', { name: 'Missed occurrences', exact: true });
  assert.equal(
    await missed.getByLabel('Missed occurrences *', { exact: true }).getAttribute('data-value'),
    'coalesce',
  );
  await chooseHuddleOption(missed.getByLabel('Missed occurrences *', { exact: true }), 'catch-up');
  await missed.getByRole('button', { name: 'Apply setting' }).click();
  const limit = inspector.getByRole('group', { name: 'Catch-up limit', exact: true });
  await limit.getByRole('spinbutton').fill('3');
  await limit.getByRole('button', { name: 'Apply setting' }).click();
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() =>
    window.huddleFixture.source().nodes.some((node) => node.id === 'interval'),
  );
  assert.deepEqual(
    await page.evaluate(
      () => window.huddleFixture.source().nodes.find((node) => node.id === 'interval').parameters,
    ),
    {
      intervalMs: { kind: 'literal', value: 1000 },
      missed: { kind: 'literal', value: 'catch-up' },
      maxCatchUp: { kind: 'literal', value: 3 },
    },
  );
  assert.equal(
    await page.evaluate(() =>
      window.huddleFixture.requests.some((request) =>
        /\/(start|apply|run|rearm)$/.test(request.path),
      ),
    ),
    false,
  );
  if (process.env.PUDDLE_HUDDLE_SCREENSHOTS) {
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => window.huddleFixture.theme(theme), theme);
      await page.screenshot({ path: `/tmp/puddle-huddle-interval-${theme}.png` });
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    'Interval node creation, explicit defaults, numeric/enum settings and save pass without arming.',
  );
} catch (error) {
  console.error(await page.locator('body').innerText());
  await page.screenshot({ path: '/tmp/puddle-huddle-interval-failure.png' });
  throw error;
} finally {
  await browser.close();
}
