/* global window */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const editor = page.getByRole('region', { name: 'Huddle editor' });
const dialog = page.getByRole('dialog');
try {
  await page.goto(
    new URL('/test/huddle/fixture.html', process.env.PREVIEW_URL ?? 'http://127.0.0.1:5174/').href,
  );
  await page.waitForFunction(() => !!window.huddleFixture);
  await page.evaluate(() => window.huddleFixture.releaseProjects());
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByRole('button', { name: 'Review graph', exact: true }).click();
  await editor.getByRole('button', { name: 'Start', exact: true }).click();
  await dialog
    .getByLabel('Variables (JSON)', { exact: true })
    .fill('{"targetWorktree":"/project"}');
  await dialog.getByRole('button', { name: 'Start saved graph', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  for (const lost of [false, true]) {
    await editor.getByRole('button', { name: 'Run', exact: true }).click();
    await dialog.getByLabel('Input (JSON)', { exact: true }).fill('{"report":"Review"}');
    await dialog.getByRole('button', { name: 'Send input', exact: true }).click();
    await dialog.getByRole('heading', { name: 'Huddle history', exact: true }).waitFor();
    await page.evaluate(() => window.huddleFixture.runtime.uncertainReadout());
    await dialog.getByRole('button', { name: 'Operations', exact: true }).click();
    await dialog.getByText('readout · unknown', { exact: true }).waitFor();
    const check = dialog.getByRole('button', { name: 'Check delivery', exact: true });
    await check.waitFor();
    if (!lost) {
      await page.evaluate(() => window.huddleFixture.runtime.readoutSupport(false));
      await check.waitFor({ state: 'detached' });
      await page.evaluate(() => window.huddleFixture.runtime.readoutSupport(true));
      await check.waitFor();
    }
    await page.evaluate((lost) => {
      window.huddleFixture.runtime.holdNext('readouts/observe');
      if (lost) window.huddleFixture.runtime.loseNext('readouts/observe');
    }, lost);
    await check.click();
    assert(await check.isDisabled());
    await page.evaluate(() => window.huddleFixture.runtime.release());
    await dialog.getByText('readout · completed', { exact: true }).waitFor();
    await dialog.getByText('observed-destination', { exact: false }).waitFor();
    assert.equal(await check.count(), 0);
    const calls = await page.evaluate(() =>
      window.huddleFixture.requests.filter((r) => r.path.endsWith('/readouts/observe')),
    );
    assert.equal(calls.length, lost ? 2 : 1);
    assert.equal(calls.at(-1).method, 'POST');
    assert.deepEqual(Object.keys(calls.at(-1).body).sort(), ['operation_id', 'target']);
    assert(
      (await page.evaluate(() => window.huddleFixture.runtime.executions())).every(
        ({ record }) => record.state === 'failed',
      ),
    );
    if (lost)
      await dialog.getByRole('button', { name: 'Inspect previous command', exact: true }).click();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
  }
  assert.deepEqual(errors, []);
  console.log(
    'Readout history gates observation by owner support, sends once, and retains ended graph state after a lost reply.',
  );
} catch (error) {
  console.error(await page.locator('body').innerText());
  await page.screenshot({ path: '/tmp/puddle-readout-observation-browser-failure.png' });
  throw error;
} finally {
  await browser.close();
}
