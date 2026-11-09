import { huddleOptions } from './helpers/controls.mjs';
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
      '/test/huddle/fixture.html?session-triggers&agent-templates',
      process.env.PREVIEW_URL ?? 'http://127.0.0.1:5174/',
    ).href,
  );
  await page.waitForFunction(() => !!window.huddleFixture);
  await page.evaluate(() => window.huddleFixture.releaseProjects());
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByRole('button', { name: 'Review graph', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Huddle editor' });
  await editor.getByRole('button', { name: 'Add node', exact: true }).click();
  await editor.getByRole('button', { name: 'Add Turn completed', exact: true }).click();
  await editor.getByRole('button', { name: 'Add node', exact: true }).click();
  await inspectNode(editor.getByRole('button', { name: 'Turn completed event', exact: true }));
  const inspector = editor.getByRole('complementary', { name: 'Node inspector' });
  await inspector.getByText('Observe exact completed external turns', { exact: false }).waitFor();
  const worktree = inspector.getByRole('group', { name: 'Worktree', exact: true });
  assert.equal(
    await worktree.getByLabel('Worktree *', { exact: true }).getAttribute('data-value'),
    '',
  );
  await chooseHuddleOption(worktree.getByLabel('Worktree *', { exact: true }), '/preview/puddle');
  await worktree.getByRole('button', { name: 'Apply setting' }).click();
  const agent = inspector.getByRole('group', { name: 'Agent', exact: true });
  const selector = agent.getByLabel('Agent *', { exact: true });
  assert.equal(await selector.getAttribute('data-value'), '');
  const options = (await huddleOptions(selector)).map((item) => item.label);
  assert(options.some((text) => text.includes('Coder')));
  assert(options.some((text) => text.includes('Reviewer')));
  assert(!options.some((text) => text.includes('Archived terminal')));
  assert(!options.some((text) => text.includes('Review graph')));
  await chooseHuddleOption(selector, '00000000-0000-4000-8000-000000000005');
  await agent.getByRole('button', { name: 'Apply setting' }).click();
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() =>
    window.huddleFixture
      .source()
      .nodes.some((node) => node.source.component === 'puddle.trigger.turn-completed'),
  );
  const saved = await page.evaluate(() =>
    window.huddleFixture
      .source()
      .nodes.find((node) => node.source.component === 'puddle.trigger.turn-completed'),
  );
  assert.deepEqual(saved.parameters, {
    worktree: { kind: 'literal', value: '/preview/puddle' },
    session: { kind: 'literal', value: '00000000-0000-4000-8000-000000000005' },
  });
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
    'Completion node uses explicit worktree/live-agent settings and saves without arming.',
  );
} catch (error) {
  console.error(await page.locator('body').innerText());
  await page.screenshot({ path: '/tmp/puddle-huddle-completions-failure.png' });
  throw error;
} finally {
  await browser.close();
}
