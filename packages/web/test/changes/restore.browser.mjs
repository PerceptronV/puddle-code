/* global window */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 600, height: 650 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    new URL('/test/changes/restore.html', process.env.PREVIEW_URL ?? 'http://127.0.0.1:5174').href,
  );
  const action = (name) => page.getByRole('button', { name, exact: true });
  const box = async (name) => {
    const result = await action(name).boundingBox();
    assert.ok(result, `${name} is visible`);
    return result;
  };
  for (const flat of [false, true]) {
    if (flat) await action('Show changes as flat list').click();
    const header = await box('Stage all changes');
    for (const name of [
      'Stage docs/roadmap/code-quality.md',
      'Stage notes.txt',
      ...(!flat ? ['Stage docs/roadmap'] : []),
    ]) {
      assert.ok(Math.abs((await box(name)).x - header.x) < 0.1, `${name} aligns with header`);
    }
    const restore = await box('Restore docs/roadmap/code-quality.md');
    assert.ok(restore.x < header.x, 'Return arrow is left of +');
  }
  await action('Restore notes.txt').click();
  await page.getByRole('dialog').waitFor();
  assert.match(await page.getByRole('dialog').innerText(), /permanently deletes/);
  await action('Cancel').click();
  assert.equal(await page.evaluate(() => window.restoreRequests.length), 0);
  await action('Restore notes.txt').click();
  await action('Delete file').click();
  await page.waitForFunction(() => window.restoreRequests.length === 1);
  assert.deepEqual(await page.evaluate(() => window.restoreRequests[0]), {
    method: 'POST',
    path: '/api/worktrees/fixture/git-restore',
    body: { repository: '/synthetic', path: 'notes.txt', delete_untracked: true },
  });
  await action('Restore docs/roadmap/code-quality.md').click();
  assert.match(await page.getByRole('dialog').innerText(), /staged changes are kept/);
  await page.getByRole('dialog').getByRole('button', { name: 'Restore', exact: true }).click();
  await page.waitForFunction(() => window.restoreRequests.length === 2);
  assert.equal(await page.evaluate(() => window.restoreRequests[1].body.delete_untracked), false);
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await action('Show changes as tree').click();
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/puddle-restore.png' });
  console.log('Restore confirmation, request scoping, and tree/flat icon alignment passed.');
} finally {
  await browser.close();
}
