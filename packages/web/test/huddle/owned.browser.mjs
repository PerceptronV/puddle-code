import { inspectNode, chooseHuddleOption } from './helpers/controls.mjs';
/* global window */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const origin = process.env.PREVIEW_URL ?? 'http://localhost:5174/';
async function open(query) {
  await page.goto(new URL(`/test/huddle/fixture.html?${query}`, origin).href);
  await page.waitForFunction(() => !!window.huddleFixture);
  await page.evaluate(() => window.huddleFixture.releaseProjects());
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByRole('button', { name: 'Review graph', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Huddle editor' });
  await editor.getByRole('button', { name: 'Add node', exact: true }).click();
  return editor;
}
try {
  const editor = await open('agent-templates');
  for (const name of ['Prompt spawned agent', 'Review spawned agent'])
    await editor.getByRole('button', { name: `Add ${name}`, exact: true }).click();
  await editor.getByRole('button', { name: 'Add node', exact: true }).click();
  await editor.getByRole('button', { name: 'Fit graph', exact: true }).click();
  for (const name of ['Prompt spawned agent', 'Review spawned agent']) {
    await inspectNode(
      editor.getByRole('button', { name: `${name} value agent completed turn`, exact: true }),
    );
    const inspector = editor.getByRole('complementary', { name: 'Node inspector' });
    await inspector.getByText(/Retained inputs: agent/).waitFor();
    assert.equal(
      await inspector.getByRole('group', { name: 'Agent session', exact: true }).count(),
      0,
    );
    const worktree = inspector.getByRole('group', { name: 'Worktree', exact: true });
    await chooseHuddleOption(worktree.getByLabel('Worktree *', { exact: true }), '/preview/puddle');
    await worktree.getByRole('button', { name: 'Apply setting' }).click();
    assert.ok(
      (
        await inspector
          .getByRole('group', { name: 'Prompt', exact: true })
          .getByRole('textbox')
          .inputValue()
      ).includes('{{input}}'),
    );
  }
  assert.ok(
    (
      await editor
        .getByRole('button', { name: 'Input review-spawned-agent.agent', exact: true })
        .getAttribute('aria-description')
    ).includes('feedback rounds'),
  );
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => window.huddleFixture.source().nodes.length === 4);
  const files = await page.evaluate(() => window.huddleFixture.componentFiles());
  const manifests = Object.entries(files)
    .filter(([name]) => name.endsWith('/node.json'))
    .map(([, file]) => JSON.parse(file.content));
  assert.equal(
    manifests.filter((contract) => contract.inputs.agent?.scope === 'execution').length,
    2,
  );
  assert.equal(
    await page.evaluate(() =>
      window.huddleFixture.requests.some((request) => /\/(start|run|resume)$/.test(request.path)),
    ),
    false,
  );
  await page.screenshot({ path: '/tmp/puddle-huddle-owned-inspector.png' });
  const older = await open('old-owned');
  await older.getByRole('button', { name: 'Add Spawn agent', exact: true }).waitFor();
  assert.equal(
    await older.getByRole('button', { name: 'Add Prompt spawned agent', exact: true }).count(),
    0,
  );
  assert.equal(
    await older.getByRole('button', { name: 'Add Review spawned agent', exact: true }).count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    'Spawned-agent templates, retained-input explanations, saved contracts and older-host gating pass without execution.',
  );
} finally {
  await browser.close();
}
