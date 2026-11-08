/* global window, Event */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15_000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const origin = process.env.PREVIEW_URL ?? 'http://localhost:5174/';
async function open() {
  await page.goto(new URL('/test/huddle/fixture.html?agent-authoring', origin).href);
  await page.waitForFunction(() => !!window.huddleFixture);
  await page.evaluate(() => window.huddleFixture.releaseProjects());
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByRole('button', { name: 'Review graph', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Huddle editor' });
  await editor.getByRole('button', { name: 'Edit with agent', exact: true }).waitFor();
  return editor;
}
const requests = () => page.evaluate(() => window.huddleFixture.requests);
const creations = async () =>
  (await requests()).filter((r) => r.method === 'POST' && r.path === '/api/sessions');
async function noExecution() {
  assert.equal(
    (await requests()).some(
      (r) => r.method === 'POST' && /\/(start|apply|run|resume)$/.test(r.path),
    ),
    false,
  );
}
try {
  let editor = await open();
  await editor.getByRole('button', { name: 'Add node', exact: true }).click();
  await editor.getByRole('button', { name: 'Add Result', exact: true }).click();
  assert.equal(
    await editor.getByRole('button', { name: 'Edit with agent', exact: true }).isDisabled(),
    true,
  );
  await editor.getByRole('button', { name: 'Undo', exact: true }).click();
  await editor.getByRole('button', { name: 'Edit with agent', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Edit huddle with agent' });
  const task = 'Add a bounded review loop; leave it inactive.';
  await dialog.getByLabel('Task', { exact: true }).fill(task);
  assert.equal(
    await dialog.getByRole('button', { name: 'Start authoring agent' }).isDisabled(),
    true,
  );
  await dialog.getByLabel('Authoring account').click();
  assert.equal(await page.getByRole('option', { name: /Other profile/ }).count(), 0);
  assert.equal(await page.getByRole('option', { name: /Logged out/ }).isDisabled(), true);
  // Ordinary authoring accounts do not need graph scripted-turn capabilities.
  await page.getByRole('option', { name: 'plain/Unsupported', exact: true }).waitFor();
  await page.getByRole('option', { name: 'codex/Coding', exact: true }).click();
  await page.screenshot({ path: '/tmp/puddle-huddle-agent-authoring.png' });
  await page.evaluate(() => window.huddleFixture.holdAuthoring());
  await dialog.getByRole('button', { name: 'Start authoring agent' }).click();
  await dialog.getByRole('button', { name: 'Starting…' }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Cancel' }).isDisabled(), true);
  await dialog.locator('form').evaluate((form) => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal((await creations()).length, 1);
  await page.evaluate(() => window.huddleFixture.releaseAuthoring());
  await dialog.waitFor({ state: 'hidden' });
  await page.locator('[data-pane-tab="term:00000000-0000-4000-8000-000000000008"]').waitFor();
  const [{ body }] = await creations();
  assert.equal(body.account_id, 12);
  assert.equal(body.project_id, await page.evaluate(() => window.huddleFixture.project));
  assert.equal(body.kind, 'agent');
  assert.equal(body.join_worktree, '/preview/puddle');
  assert.equal(body.separate_branch, false);
  assert.equal(body.separate_worktree, false);
  assert.equal(body.skip_permissions, false);
  assert.ok(
    body.prompt.includes('/preview/puddle/.puddle/huddle/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'),
  );
  assert.ok(body.prompt.includes('name: puddle-huddle'));
  assert.ok(body.prompt.endsWith(task));
  assert.equal(await page.evaluate(() => window.huddleFixture.source().nodes.length), 2);
  await noExecution();

  // A removed account stays selected and cannot silently become another account.
  editor = await open();
  await editor.getByRole('button', { name: 'Edit with agent', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit huddle with agent' });
  await dialog.getByLabel('Task', { exact: true }).fill(task);
  await dialog.getByLabel('Authoring account').click();
  await page.getByRole('option', { name: 'codex/Coding', exact: true }).click();
  await page.evaluate(() => window.huddleFixture.removeAuthoringAccount(12));
  await dialog.getByRole('button', { name: 'Refresh accounts' }).click();
  await dialog
    .getByRole('combobox', { name: 'Authoring account' })
    .filter({ hasText: 'Unavailable account (12)' })
    .waitFor();
  assert.equal(
    await dialog.getByRole('button', { name: 'Start authoring agent' }).isDisabled(),
    true,
  );
  assert.equal((await creations()).length, 0);
  await dialog.getByLabel('Authoring account').click();
  await page.getByRole('option', { name: 'claude/Primary', exact: true }).click();
  await page.evaluate(() => window.huddleFixture.failAuthoring());
  await dialog.getByRole('button', { name: 'Start authoring agent' }).click();
  await dialog.getByRole('alert').filter({ hasText: 'A session may have been created' }).waitFor();
  assert.equal(
    await dialog.getByRole('button', { name: 'Start authoring agent' }).isDisabled(),
    true,
  );
  await dialog.locator('form').evaluate((form) => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal((await creations()).length, 1);
  assert.equal((await creations())[0].body.account_id, 11);
  await noExecution();
  assert.deepEqual(errors, []);
  console.log(
    'Explicit authoring accounts, exact worktree/context, dirty-source admission, navigation and lost-reply non-retry pass without graph execution.',
  );
} catch (error) {
  await page.screenshot({ path: '/tmp/puddle-huddle-authoring-failure.png' });
  console.error(errors);
  throw error;
} finally {
  await browser.close();
}
