/* global window */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(
    new URL('/test/huddle/fixture.html', process.env.PREVIEW_URL ?? 'http://127.0.0.1:5174/').href,
  );
  await page.waitForFunction(() => !!window.huddleFixture);
  await page.evaluate(() => window.huddleFixture.releaseProjects());
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByRole('button', { name: 'Review graph', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Huddle editor' });
  await editor.getByRole('button', { name: 'Start', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Variables (JSON)', { exact: true })
    .fill('{"targetWorktree":"/project"}');
  await dialog.getByRole('button', { name: 'Start saved graph', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.evaluate(() => window.huddleFixture.runtime.customTriggerHealth(true));
  const health = editor.getByRole('list', { name: 'Custom trigger health', includeHidden: true });
  await health.getByText('healthy · ready', { exact: true }).waitFor();
  await health.getByText('feed · gap', { exact: true }).waitFor();
  await editor.getByText('Source cursor expired', { exact: false }).waitFor();
  assert(await editor.getByRole('button', { name: 'Run', exact: true }).isEnabled());
  await page.evaluate(() => window.huddleFixture.runtime.customTriggerHealth(false));
  const closed = health.getByText('feed · closed', { exact: true });
  await closed.waitFor({ state: 'attached' });
  if (!(await closed.isVisible()))
    await editor.getByText('Custom triggers · 1 ready', { exact: true }).click();
  await closed.waitFor();
  const commands = await page.evaluate(() =>
    window.huddleFixture.requests.filter(
      (r) => r.method === 'POST' && /\/(start|run|apply|rearm|interrupt)$/.test(r.path),
    ),
  );
  assert.equal(commands.length, 1);
  assert.deepEqual(errors, []);
  console.log(
    'Custom trigger gaps are visible beside healthy sources without dispatching lifecycle commands.',
  );
} catch (error) {
  console.error(await page.locator('body').innerText());
  await page.screenshot({ path: '/tmp/puddle-custom-triggers-browser-failure.png' });
  throw error;
} finally {
  await browser.close();
}
