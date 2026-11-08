/* global window */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const editor = page.getByRole('region', { name: 'Huddle editor' });
const dialog = page.getByRole('dialog');
const action = (name) => editor.getByRole('button', { name, exact: true });
const count = (name) =>
  page.evaluate(
    (name) =>
      window.huddleFixture.requests.filter(
        (r) => r.path.endsWith(`/${name}`) && r.method === 'POST',
      ).length,
    name,
  );
async function open(query = '') {
  await page.goto(
    new URL(
      `/test/huddle/fixture.html${query}`,
      process.env.PREVIEW_URL ?? 'http://localhost:5174/',
    ).href,
  );
  await page.waitForFunction(() => !!window.huddleFixture);
  await page.evaluate(() => window.huddleFixture.releaseProjects());
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByRole('button', { name: 'Review graph', exact: true }).click();
  await editor.waitFor();
}
async function close() {
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
}
async function run(data) {
  await action('Run').click();
  await dialog.getByLabel('Input (JSON)', { exact: true }).fill(JSON.stringify(data));
  await dialog.getByRole('button', { name: 'Send input', exact: true }).click();
}
try {
  await open('?old-execution');
  await editor.getByRole('button', { name: 'Open definition', exact: true }).waitFor();
  assert.equal(await action('Start').count(), 0);
  assert.equal(
    await page.evaluate(() =>
      window.huddleFixture.requests.some((r) => /\/sessions\/[^/]+\/runtime$/.test(r.path)),
    ),
    false,
  );
  await open();
  await action('Start').click();
  await dialog.getByRole('button', { name: 'Start saved graph', exact: true }).click();
  await dialog.getByRole('alert').waitFor();
  assert.equal(await count('start'), 0);
  await dialog
    .getByLabel('Variables (JSON)', { exact: true })
    .fill('{"targetWorktree":"/project"}');
  await page.evaluate(() => window.huddleFixture.runtime.holdNext('start'));
  await dialog.getByRole('button', { name: 'Start saved graph', exact: true }).click();
  await dialog.getByRole('button', { name: 'Sending…', exact: true }).waitFor();
  assert.equal(
    await dialog.getByRole('button', { name: 'Sending…', exact: true }).isDisabled(),
    true,
  );
  assert.equal(await count('start'), 1);
  await page.evaluate(() => window.huddleFixture.runtime.release());
  await dialog.waitFor({ state: 'detached' });
  await editor.getByText('Armed · idle', { exact: true }).waitFor();
  assert.equal(await count('run'), 0);
  await run({ prompt: 'First result' });
  await dialog.getByRole('heading', { name: 'Huddle history', exact: true }).waitFor();
  await dialog.getByText('result · completed', { exact: true }).waitFor();
  await dialog.getByText('Result', { exact: true }).waitFor();
  assert.equal(await count('run'), 1);
  await dialog.getByRole('button', { name: 'Operations', exact: true }).click();
  await dialog.getByText('No operations on this page.', { exact: true }).waitFor();
  await close();

  // A local draft cannot silently replace the running graph.
  await action('Add node').click();
  await action('Add Result').click();
  await editor.getByText('Unsaved changes', { exact: true }).waitFor();
  assert.equal(await action('Apply saved').isDisabled(), true);
  assert.equal(await action('Run').isEnabled(), true);
  await action('Save').click();
  await editor.getByText('Unsaved changes', { exact: true }).waitFor({ state: 'hidden' });
  await action('Apply saved').click();
  await dialog
    .getByLabel('Variables (JSON)', { exact: true })
    .fill('{"targetWorktree":"/project"}');
  await dialog.getByRole('button', { name: 'Apply saved graph', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await count('apply'), 1);
  await action('Interrupt').click();
  await editor.getByText('Interrupted', { exact: true }).waitFor();
  await action('Resume').click();
  await editor.getByText('Armed · idle', { exact: true }).waitFor();

  // Acceptance followed by a lost reply is observed, never repeated automatically.
  await page.evaluate(() => window.huddleFixture.runtime.loseNext('run'));
  await run({ prompt: 'Accepted despite lost reply' });
  await dialog
    .getByText('Close this review and inspect the previous outcome before another action.', {
      exact: true,
    })
    .waitFor();
  assert.equal(await count('run'), 2);
  await close();
  assert.equal(await action('Run').isDisabled(), true);
  await page.evaluate(() => window.huddleFixture.runtime.failObservation(true));
  await action('Inspect outcome').click();
  await editor.getByText('Runtime unavailable', { exact: true }).waitFor();
  assert.equal(await action('Run').isDisabled(), true);
  assert.equal(await count('run'), 2);
  await page.evaluate(() => window.huddleFixture.runtime.failObservation(false));
  await action('Inspect outcome').click();
  await dialog.getByRole('heading', { name: 'Huddle history', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.huddleFixture.runtime.executions().length), 2);
  assert.equal(await count('run'), 2);
  await close();
  await run({ prompt: 'Explicit next input' });
  await dialog.getByRole('heading', { name: 'Huddle history', exact: true }).waitFor();
  await dialog.getByText('result · completed', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Next page', exact: true }).click();
  await page.waitForFunction(() =>
    window.huddleFixture.requests.some(
      (r) =>
        r.path.endsWith('/history') && r.body?.collection === 'executions' && r.body?.after > 0,
    ),
  );
  await dialog.getByRole('button', { name: 'Previous page', exact: true }).click();
  await close();

  // A saved file changed after review must be reviewed again.
  await action('Apply saved').click();
  await dialog
    .getByLabel('Variables (JSON)', { exact: true })
    .fill('{"targetWorktree":"/project"}');
  await page.evaluate(() => window.huddleFixture.externalEdit('Changed after review'));
  await dialog.getByRole('button', { name: 'Apply saved graph', exact: true }).click();
  await dialog
    .getByText('Close this review and inspect the previous outcome before another action.', {
      exact: true,
    })
    .waitFor();
  await close();
  await action('Inspect outcome').click();
  await dialog.getByRole('heading', { name: 'Huddle history', exact: true }).waitFor();
  await close();
  assert.equal(await count('apply'), 2);
  assert.equal(await count('run'), 3);

  await page.evaluate(() => window.huddleFixture.theme('light'));
  await action('History').click();
  await dialog.getByRole('heading', { name: 'Huddle history', exact: true }).waitFor();
  await dialog
    .getByRole('button', { name: /^completed ·/ })
    .first()
    .click();
  await dialog.getByText('result · completed', { exact: true }).waitFor();
  await dialog.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  await page.screenshot({ path: '/tmp/puddle-huddle-history-light.png' });
  await close();
  await page.setViewportSize({ width: 760, height: 700 });
  await page.evaluate(() => window.huddleFixture.theme('dark'));
  await action('Run').click();
  await dialog.getByLabel('Input (JSON)', { exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/puddle-huddle-run-dark.png' });
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 760);
  await close();
  await action('Stop').click();
  await editor.getByText('Stopped', { exact: true }).waitFor();
  await action('Start').waitFor();
  assert.equal(await count('stop'), 1);
  assert.deepEqual(errors, []);
  console.log(
    'Huddle execution: capability gate, saved-source review, explicit input/results, lifecycle, dirty drafts, stale source, lost replies, pagination and narrow layouts pass.',
  );
} catch (error) {
  console.error('Browser errors:', errors);
  console.error(await page.locator('body').innerText());
  await page.screenshot({ path: '/tmp/puddle-huddle-execution-failure.png' });
  throw error;
} finally {
  await browser.close();
}
