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
  const editor = await open('spawn-templates');
  await editor.getByRole('button', { name: 'Add Spawn agent', exact: true }).click();
  await editor
    .getByRole('button', { name: 'Spawn agent value completed agent turn', exact: true })
    .click();
  const inspector = editor.getByRole('complementary', { name: 'Node inspector' });
  const setting = (name) => inspector.getByRole('group', { name, exact: true });
  const choose = async (name, value) => {
    const group = setting(name);
    await group.getByLabel(`${name} *`, { exact: true }).selectOption(value);
    await group.getByRole('button', { name: 'Apply setting' }).click();
  };
  const projectId = await setting('Project')
    .getByLabel('Project *', { exact: true })
    .getByRole('option')
    .nth(1)
    .getAttribute('value');
  await choose('Project', projectId);
  await choose('Worktree', '/preview/puddle');
  await choose('Provider', 'claude');
  await choose('Account', '11');
  assert.deepEqual(
    await setting('Provider')
      .getByLabel('Provider *', { exact: true })
      .getByRole('option')
      .evaluateAll((items) => items.map((item) => item.value)),
    ['', 'claude', 'codex'],
  );
  assert.deepEqual(
    await setting('Account')
      .getByLabel('Account *', { exact: true })
      .getByRole('option')
      .evaluateAll((items) => items.map((item) => item.value)),
    ['', '11'],
  );
  await choose('Provider', 'codex');
  assert.equal(
    await setting('Account').getByLabel('Account *', { exact: true }).inputValue(),
    '11',
  );
  assert.ok(
    (
      await setting('Account').getByRole('option', { name: '11 · unavailable' }).textContent()
    ).includes('unavailable'),
  );
  await choose('Account', '12');
  await choose('Mode', 'headless');
  await setting('Prompt').getByRole('textbox').fill('Implement {{input.task}}');
  await setting('Prompt').getByRole('button', { name: 'Apply setting' }).click();
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() =>
    window.huddleFixture.source().nodes.some((node) => node.id === 'spawn-agent'),
  );
  const source = await page.evaluate(() => window.huddleFixture.source());
  const node = source.nodes.find((node) => node.id === 'spawn-agent');
  for (const [name, value] of Object.entries({
    project: projectId,
    worktree: '/preview/puddle',
    provider: 'codex',
    account: '12',
    mode: 'headless',
    prompt: 'Implement {{input.task}}',
  }))
    assert.deepEqual(node.parameters[name], { kind: 'literal', value });
  const files = await page.evaluate(() => window.huddleFixture.componentFiles());
  assert.ok(Object.values(files).some((file) => file.content.includes('puddlang.spawn')));
  assert.equal(
    await page.evaluate(() =>
      window.huddleFixture.requests.some((request) => /\/(start|run|resume)$/.test(request.path)),
    ),
    false,
  );
  await page.screenshot({ path: '/tmp/puddle-huddle-spawn-inspector.png' });
  const older = await open('old-spawn');
  await older.getByRole('button', { name: 'Add Prompt agent', exact: true }).waitFor();
  assert.equal(
    await older.getByRole('button', { name: 'Add Spawn agent', exact: true }).count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    'Spawn template publication, explicit resource choices, unavailable selections, saved source and older-host gating pass without execution.',
  );
} finally {
  await browser.close();
}
