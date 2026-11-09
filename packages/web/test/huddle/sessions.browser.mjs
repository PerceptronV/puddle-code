import { inspectNode, chooseHuddleOption } from './helpers/controls.mjs';
/* global window */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(
    new URL(
      '/test/huddle/fixture.html?session-triggers',
      process.env.PREVIEW_URL ?? 'http://localhost:5174/',
    ).href,
  );
  await page.waitForFunction(() => !!window.huddleFixture);
  await page.evaluate(() => window.huddleFixture.releaseProjects());
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByRole('button', { name: 'Review graph', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Huddle editor' });
  await editor.getByRole('button', { name: 'Add node', exact: true }).click();
  await editor.getByRole('button', { name: 'Add Session lifecycle', exact: true }).click();
  await editor.getByRole('button', { name: 'Add node', exact: true }).click();
  await inspectNode(editor.getByRole('button', { name: 'Session lifecycle event', exact: true }));
  const inspector = editor.getByRole('complementary', { name: 'Node inspector' });
  const worktree = inspector.getByRole('group', { name: 'Worktree', exact: true });
  assert.equal(
    await worktree.getByLabel('Worktree *', { exact: true }).getAttribute('data-value'),
    '',
  );
  await chooseHuddleOption(worktree.getByLabel('Worktree *', { exact: true }), '/preview/puddle');
  await worktree.getByRole('button', { name: 'Apply setting' }).click();
  const session = inspector.getByRole('group', { name: 'Session', exact: true });
  assert.equal(await session.getByLabel('Session', { exact: true }).getAttribute('data-value'), '');
  await chooseHuddleOption(
    session.getByLabel('Session', { exact: true }),
    '00000000-0000-4000-8000-000000000009',
  );
  await session.getByRole('button', { name: 'Apply setting' }).click();
  const set = async (name, value) => {
    const group = inspector.getByRole('group', { name, exact: true });
    await group.getByRole('textbox').fill(value);
    await group.getByRole('button', { name: 'Apply setting' }).click();
  };
  await set('Session kinds', '["terminal"]');
  await set('Events', '["status"]');
  await set('Status transitions to', '["exited"]');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() =>
    window.huddleFixture
      .source()
      .nodes.some((node) => node.source.component === 'puddle.trigger.session'),
  );
  const saved = await page.evaluate(() =>
    window.huddleFixture
      .source()
      .nodes.find((node) => node.source.component === 'puddle.trigger.session'),
  );
  assert.deepEqual(saved.parameters, {
    worktree: { kind: 'literal', value: '/preview/puddle' },
    session: { kind: 'literal', value: '00000000-0000-4000-8000-000000000009' },
    kinds: { kind: 'literal', value: ['terminal'] },
    events: { kind: 'literal', value: ['status'] },
    statuses: { kind: 'literal', value: ['exited'] },
  });
  await session.getByRole('button', { name: 'Clear setting' }).click();
  assert.equal(await session.getByLabel('Session', { exact: true }).getAttribute('data-value'), '');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(
    () =>
      !window.huddleFixture
        .source()
        .nodes.find((node) => node.source.component === 'puddle.trigger.session').parameters
        .session,
  );
  assert.equal(
    await page.evaluate(() =>
      window.huddleFixture.requests.some((request) =>
        /\/(start|apply|run|rearm)$/.test(request.path),
      ),
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    'Session trigger settings include archived terminals, preserve an unset selector and save without arming.',
  );
} catch (error) {
  console.error(await page.locator('body').innerText());
  await page.screenshot({ path: '/tmp/puddle-huddle-sessions-failure.png' });
  throw error;
} finally {
  await browser.close();
}
