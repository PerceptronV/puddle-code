/* global window */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(20_000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(
    new URL(
      '/test/huddle/fixture.html?source-saves&retained-history',
      process.env.PREVIEW_URL ?? 'http://127.0.0.1:5189/',
    ).href,
  );
  await page.waitForFunction(() => !!window.huddleFixture);
  await page.evaluate(() => window.huddleFixture.releaseProjects());
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByRole('button', { name: 'Review graph', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Huddle editor' });
  await editor.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('heading', { name: 'Recorded huddle runtimes' }).waitFor();
  await page.getByRole('button').filter({ hasText: 'recorded-fixture' }).click();
  await page.getByText('Recorded ledger history.', { exact: false }).waitFor();
  await page.getByRole('button').filter({ hasText: 'completed · 33333333' }).click();
  await page.getByText('Retained after Stop', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Execution source', exact: true }).click();
  await page.getByRole('heading', { name: 'Recorded huddle revision' }).waitFor();
  await page
    .getByLabel('Revision source', { exact: true })
    .getByText('// Historical execution source', { exact: false })
    .first()
    .waitFor();
  assert.equal(
    await page.getByText('Recorded variables and resolved bindings', { exact: true }).count(),
    0,
  );
  await page.getByRole('button', { name: 'Back to history', exact: true }).click();
  await page.getByRole('button', { name: 'Recorded activation', exact: true }).click();
  await page.getByText('Recorded variables and resolved bindings', { exact: true }).click();
  await page.getByText('retained setting', { exact: false }).waitFor();
  await page
    .getByLabel('Revision source', { exact: true })
    .getByText('// Last recorded activation', { exact: false })
    .first()
    .waitFor();
  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => window.huddleFixture.theme(theme), theme);
    await page.screenshot({ path: `/tmp/huddle-retained-revision-${theme}.png` });
  }
  await page.getByRole('button', { name: 'Back to history', exact: true }).click();
  await page.getByRole('button', { name: 'Operations', exact: true }).click();
  await page.getByText('Destination reply was lost', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: /Observe readout|Inspect previous command/ }).count(),
    0,
  );
  const before = await page.evaluate(
    () =>
      window.huddleFixture.requests.filter((request) => request.path.endsWith('/history/retained'))
        .length,
  );
  await page.waitForTimeout(3400);
  assert.equal(
    await page.evaluate(
      () =>
        window.huddleFixture.requests.filter((request) =>
          request.path.endsWith('/history/retained'),
        ).length,
    ),
    before,
    'recorded views do not poll copied ledgers',
  );
  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => window.huddleFixture.theme(theme), theme);
    await page.screenshot({ path: `/tmp/huddle-retained-history-${theme}.png` });
  }
  await page.evaluate(() => window.huddleFixture.retainedHistory.fail(true));
  await page.getByRole('button', { name: 'Refresh executions', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'no owner was started' }).waitFor();
  await page.getByRole('button', { name: 'Recorded runtimes', exact: true }).click();
  await page.getByRole('heading', { name: 'Recorded huddle runtimes' }).waitFor();
  assert.equal(
    await page.evaluate(() =>
      window.huddleFixture.requests.some((request) =>
        /\/(start|run|apply|rearm|stop|readouts\/observe)$/.test(request.path),
      ),
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    'Stopped-owner history, retained results/unknown outcomes, explicit refresh, no polling/actions and runtime navigation pass.',
  );
} catch (error) {
  console.error(errors);
  console.error(await page.locator('body').innerText());
  await page.screenshot({ path: '/tmp/huddle-retained-history-failure.png' });
  throw error;
} finally {
  await browser.close();
}
