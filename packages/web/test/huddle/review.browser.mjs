/* global window */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const editor = page.getByRole('region', { name: 'Huddle editor' });
const dialog = page.getByRole('dialog');
const action = (name) => editor.getByRole('button', { name, exact: true });
const count = (action) =>
  page.evaluate(
    (action) =>
      window.huddleFixture.requests.filter(
        (r) => r.path.endsWith('/' + action) && r.method === 'POST',
      ).length,
    action,
  );
async function open(query = '') {
  await page.goto(
    new URL(
      `/test/huddle/fixture.html${query}`,
      process.env.PREVIEW_URL ?? 'http://127.0.0.1:5189/',
    ).href,
  );
  await page.waitForFunction(() => !!window.huddleFixture);
  await page.evaluate(() => window.huddleFixture.releaseProjects());
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByRole('button', { name: 'Review graph', exact: true }).click();
  await editor.waitFor();
  await action('Start').click();
  await dialog
    .getByLabel('Variables (JSON)', { exact: true })
    .fill('{"targetWorktree":"/project"}');
  await dialog.getByRole('button', { name: 'Start saved graph', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await editor.getByText('Armed · idle', { exact: true }).waitFor();
}
async function close() {
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
}
try {
  await open();
  await action('Active revision').click();
  await dialog.getByRole('heading', { name: 'Active huddle revision', exact: true }).waitFor();
  await dialog
    .locator('.monaco-editor .view-lines')
    .getByText(/Review\s+graph/)
    .waitFor();
  await dialog.getByText('Active variables and resolved bindings', { exact: true }).click();
  await dialog
    .getByText(/"targetWorktree": "\/project"/)
    .first()
    .waitFor();
  await dialog.getByRole('button', { name: /Contract · run/ }).click();
  await dialog.locator('.monaco-editor').waitFor();
  assert.equal(await count('apply'), 0);
  assert.equal(await count('run'), 0);
  await close();

  await page.evaluate(() => window.huddleFixture.externalEdit('Reviewed saved graph'));
  await action('Apply saved').click();
  await dialog.getByRole('heading', { name: 'Apply saved graph', exact: true }).waitFor();
  await dialog.getByText('1 changed entry', { exact: true }).waitFor();
  await dialog
    .locator('.monaco-diff-editor .original .view-lines')
    .getByText(/Review\s+graph/)
    .waitFor();
  await dialog
    .locator('.monaco-diff-editor .modified .view-lines')
    .getByText(/Reviewed\s+saved\s+graph/)
    .waitFor();
  assert.deepEqual(
    JSON.parse(await dialog.getByLabel('Variables (JSON)', { exact: true }).inputValue()),
    { targetWorktree: '/project' },
  );
  assert.equal(await count('apply'), 0);
  await dialog.getByRole('button', { name: 'Show all entries', exact: true }).click();
  await dialog.getByRole('button', { name: /Contract · run/ }).click();
  await dialog.getByRole('button', { name: 'huddle.json modified', exact: true }).click();
  await dialog
    .locator('.monaco-diff-editor .modified .view-lines')
    .getByText(/Reviewed\s+saved\s+graph/)
    .waitFor();
  await dialog.getByRole('button', { name: 'Apply saved graph', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await count('apply'), 1);
  assert.equal(await count('run'), 0);

  // A later external edit does not silently replace the reviewed digest.
  await action('Apply saved').click();
  await dialog.getByRole('heading', { name: 'Apply saved graph', exact: true }).waitFor();
  await page.evaluate(() => window.huddleFixture.externalEdit('Intervening agent edit'));
  await dialog.getByRole('button', { name: 'Apply saved graph', exact: true }).click();
  await dialog.getByRole('alert').waitFor();
  assert.equal(await count('apply'), 2);
  await close();
  assert.equal(await count('apply'), 2);

  await open();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => window.huddleFixture.theme('dark'));
  await action('Active revision').click();
  await dialog
    .locator('.monaco-editor .view-lines')
    .getByText(/Review\s+graph/)
    .waitFor();
  await page.screenshot({ path: '/tmp/huddle-review-dark.png', fullPage: true });
  await close();

  await open('?old-review');
  assert.equal(await action('Active revision').count(), 0);
  await action('Apply saved').click();
  await dialog.getByRole('heading', { name: 'Apply saved graph', exact: true }).waitFor();
  assert.equal(await count('diff'), 0);
  await close();
  assert.deepEqual(errors, []);
  console.log(
    'PASS: active source/contracts, Apply diff, variables, stale source and older-host gating',
  );
} catch (error) {
  console.error('Dialog:', await dialog.textContent().catch(() => 'closed'));
  console.error('Page errors:', errors);
  await page.screenshot({ path: '/tmp/huddle-review-failure.png', fullPage: true });
  throw error;
} finally {
  await browser.close();
}
