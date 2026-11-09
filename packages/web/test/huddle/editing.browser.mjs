/* global window */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(
    new URL(
      `/test/huddle/fixture.html${process.env.HUDDLE_CAPTURED_SOURCE ? '?source-saves' : ''}`,
      process.env.PREVIEW_URL ?? 'http://localhost:5174/',
    ).href,
  );
  await page.waitForFunction(() => !!window.huddleFixture);
  await page.evaluate(() => window.huddleFixture.releaseProjects());
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByRole('button', { name: 'Review graph', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Huddle editor' });
  const validate = editor.getByRole('button', { name: 'Validate', exact: true });
  if (process.env.HUDDLE_CAPTURED_SOURCE) {
    await validate.click();
    const dialog = page.getByRole('dialog', { name: 'Validate saved huddle' });
    await dialog.getByRole('button', { name: 'Check saved source' }).click();
    await dialog.getByText('Saved source checks passed.', { exact: true }).waitFor();
    await dialog.getByLabel('Contract fixture paths (optional)').fill('fixtures/contracts.json');
    await dialog.getByRole('button', { name: 'Check saved source' }).click();
    await dialog.getByText('Saved source needs attention.', { exact: true }).waitFor();
    await dialog.getByText('run: Sample: invalid fixture input', { exact: false }).waitFor();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  } else assert.equal(await validate.isDisabled(), true);
  await editor.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = editor.getByRole('form', { name: 'Execution settings' });
  const updateSettings = settings.getByRole('button', { name: 'Update execution draft' });
  await settings.getByLabel('Agent turns per execution', { exact: true }).fill('0');
  assert.equal(await updateSettings.isDisabled(), true);
  await settings.getByLabel('Agent turns per execution', { exact: true }).fill('12');
  await settings.getByLabel('Owned agent cleanup').selectOption('retain-owned');
  if (process.env.HUDDLE_CAPTURED_SOURCE)
    await settings.getByLabel('Default event admission', { exact: true }).selectOption('coalesce');
  else assert.equal(await settings.locator('option[value="coalesce"]').count(), 0);
  await updateSettings.click();
  await editor.getByText('Unsaved changes', { exact: true }).waitFor();
  assert.notEqual(await page.evaluate(() => window.huddleFixture.source().execution?.maxTurns), 12);
  await editor.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(
    await settings.getByLabel('Agent turns per execution', { exact: true }).inputValue(),
    '50',
  );
  await editor.getByRole('button', { name: 'Redo', exact: true }).click();
  assert.equal(
    await settings.getByLabel('Agent turns per execution', { exact: true }).inputValue(),
    '12',
  );
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => window.huddleFixture.source().execution?.maxTurns === 12);
  assert.equal(
    await page.evaluate(() => window.huddleFixture.source().execution.cleanup),
    'retain-owned',
  );
  await editor.getByRole('button', { name: 'Settings', exact: true }).click();
  await editor.getByRole('button', { name: 'Run event', exact: true }).click();
  const admission = editor.getByRole('group', { name: 'Trigger admission', exact: true });
  if (process.env.HUDDLE_CAPTURED_SOURCE) {
    assert.equal(
      await page.evaluate(() => window.huddleFixture.source().execution.queue),
      'coalesce',
    );
    await admission.getByLabel('Event policy', { exact: true }).selectOption('drop');
    await admission.getByLabel('Queued events for this trigger', { exact: true }).fill('2');
    await admission.getByRole('button', { name: 'Update trigger draft' }).click();
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(
      () => window.huddleFixture.source().execution.triggerAdmission?.run?.policy === 'drop',
    );
    assert.deepEqual(
      await page.evaluate(() => window.huddleFixture.source().execution.triggerAdmission),
      { run: { policy: 'drop', maxQueuedEvents: 2 } },
    );
    await admission.getByLabel('Event policy', { exact: true }).selectOption('inherit');
    await admission.getByRole('button', { name: 'Update trigger draft' }).click();
    await editor.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.equal(await admission.getByLabel('Event policy', { exact: true }).inputValue(), 'drop');
  } else
    assert.equal(await admission.getByLabel('Event policy', { exact: true }).isDisabled(), true);
  await editor.getByRole('button', { name: 'Add node', exact: true }).click();
  await editor.getByRole('button', { name: 'Add Result', exact: true }).click();
  await editor.getByText('Unsaved changes', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.huddleFixture.source().nodes.length), 2);
  await editor.getByRole('button', { name: 'Connections', exact: true }).click();
  await editor.getByLabel('Output', { exact: true }).selectOption({ label: 'run.event' });
  await editor.getByLabel('Input', { exact: true }).selectOption({ label: 'result-2.value' });
  await editor.getByRole('button', { name: 'Connect', exact: true }).click();
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => window.huddleFixture.source().edges.length === 2);
  await editor.getByText('Unsaved changes', { exact: true }).waitFor({ state: 'hidden' });
  await editor.getByRole('button', { name: 'Undo', exact: true }).click();
  await editor.getByText('Unsaved changes', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.huddleFixture.source().edges.length), 2);
  await editor.getByRole('button', { name: 'Redo', exact: true }).click();
  await editor.getByText('Unsaved changes', { exact: true }).waitFor({ state: 'hidden' });
  await editor.getByRole('button', { name: 'Add node', exact: true }).click();
  await editor.getByRole('button', { name: 'Connections', exact: true }).click();
  await editor.getByRole('button', { name: 'Result value', exact: true }).nth(1).click();
  await editor.getByRole('button', { name: 'Choose node icon', exact: true }).click();
  await page.getByRole('button', { name: 'bird', exact: true }).click();
  await editor
    .getByRole('group', { name: 'Node colour', exact: true })
    .getByRole('button', { name: 'blue', exact: true })
    .click();
  await page.evaluate(() => window.huddleFixture.action('editor.save'));
  await page.waitForFunction(
    () =>
      window.huddleFixture.source().nodes.find((node) => node.id === 'result-2')?.appearance
        ?.colour === 'blue',
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.huddleFixture.source().nodes.find((node) => node.id === 'result-2').appearance.icon,
    ),
    'bird',
  );
  await editor.getByRole('button', { name: 'Delete node', exact: true }).click();
  assert.equal(await editor.getByRole('button', { name: 'Result value', exact: true }).count(), 1);
  await editor.getByRole('button', { name: 'Undo', exact: true }).click();
  await editor.getByRole('button', { name: 'Result value', exact: true }).nth(1).waitFor();

  await editor.getByRole('button', { name: 'Run event', exact: true }).click();
  await editor.getByText('View built-in source', { exact: true }).click();
  assert.match(await editor.getByLabel('Built-in adapter source').innerText(), /HuddleNode/);
  const copy = editor.getByRole('button', { name: 'Make local copy', exact: true });
  if (process.env.HUDDLE_CAPTURED_SOURCE) {
    const before = await page.evaluate(() => window.huddleFixture.source());
    await copy.click();
    await editor.getByRole('button', { name: 'Open script', exact: true }).waitFor();
    assert.equal(
      await page.evaluate(
        () => window.huddleFixture.source().nodes.find((node) => node.id === 'run').source.kind,
      ),
      'builtin',
    );
    await editor.getByRole('button', { name: 'Undo', exact: true }).click();
    await copy.waitFor();
    await editor.getByRole('button', { name: 'Redo', exact: true }).click();
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(
      () =>
        window.huddleFixture.source().nodes.find((node) => node.id === 'run').source.kind ===
        'local',
    );
    const after = await page.evaluate(() => window.huddleFixture.source());
    const local = after.nodes.find((node) => node.id === 'run');
    assert.deepEqual(
      { ...local, source: before.nodes.find((node) => node.id === 'run').source },
      before.nodes.find((node) => node.id === 'run'),
    );
    assert.deepEqual(after.edges, before.edges);
    const files = await page.evaluate(() => window.huddleFixture.componentFiles());
    const manifest = JSON.parse(
      files[`.puddle/huddle/${after.id}/${local.source.manifest}`].content,
    );
    assert.deepEqual(manifest.hostTrigger, { component: 'puddle.trigger.manual', version: 1 });
    await editor.getByRole('button', { name: 'Open script', exact: true }).click();
    await page.waitForSelector('.monaco-editor');
    const script = page.locator('[data-pane-tab]').filter({ hasText: 'run.ts' });
    await script.hover();
    await script.getByRole('button', { name: 'Close run.ts', exact: true }).click();
    await script.waitFor({ state: 'hidden' });
  } else assert.equal(await copy.isDisabled(), true);

  await editor.getByRole('button', { name: 'Open definition', exact: true }).click();
  await page.waitForSelector('.monaco-editor');
  await page.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    const model = monaco.editor
      .getModels()
      .find((item) => item.uri.path.endsWith('/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/huddle.json'));
    const graph = JSON.parse(model.getValue());
    graph.name = 'Edited in source';
    model.pushStackElement();
    model.pushEditOperations(
      [],
      [{ range: model.getFullModelRange(), text: JSON.stringify(graph, null, 2) }],
      () => null,
    );
    model.pushStackElement();
  });
  const tab = page.locator('[data-pane-tab="huddle:00000000-0000-4000-8000-000000000003"]');
  await tab.click({ position: { x: 10, y: 2 } });
  await editor.getByText('Edited in source', { exact: true }).waitFor();
  const firstSourceTab = page.locator('[data-pane-tab]').filter({ hasText: 'huddle.json' });
  await firstSourceTab.hover();
  await firstSourceTab.getByRole('button', { name: 'Close huddle.json', exact: true }).click();
  await firstSourceTab.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('dialog').count(), 0);
  await editor.getByText('Edited in source', { exact: true }).waitFor();
  await page.evaluate(() => window.huddleFixture.externalEdit('Agent version'));
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await editor
    .getByText('The definition changed on disk. Your edits are intact.', { exact: false })
    .waitFor();
  assert.equal(await page.evaluate(() => window.huddleFixture.source().name), 'Agent version');
  await editor.getByRole('button', { name: 'Compare', exact: true }).click();
  await editor.getByRole('button', { name: 'Take the disk version', exact: true }).click();
  await editor.getByText('Agent version', { exact: true }).waitFor();

  await editor.getByRole('button', { name: 'Add node', exact: true }).click();
  await editor
    .getByLabel('Local component contract', { exact: true })
    .fill('nodes/review/node.json');
  await editor.getByRole('button', { name: 'Add local node', exact: true }).click();
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await editor.getByRole('button', { name: 'Reviewer request reply', exact: true }).click();
  const inspector = editor.getByRole('complementary', { name: 'Node inspector' });
  const prompt = inspector.getByRole('group', { name: 'Prompt', exact: true });
  await prompt.getByRole('textbox').fill('Review this worktree');
  await prompt.getByRole('button', { name: 'Apply setting' }).click();
  const worktree = inspector.getByRole('group', { name: 'Worktree', exact: true });
  await worktree.getByLabel('worktree binding').selectOption('variable');
  await worktree.getByLabel('Worktree *', { exact: true }).selectOption('targetWorktree');
  await worktree.getByRole('button', { name: 'Apply setting' }).click();
  const enabled = inspector.getByRole('group', { name: 'Enabled', exact: true });
  await enabled.getByLabel('Enabled *', { exact: true }).selectOption('false');
  await enabled.getByRole('button', { name: 'Apply setting' }).click();
  const options = inspector.getByRole('group', { name: 'Options', exact: true });
  await options.getByRole('textbox').fill('{"strict":true}');
  await options.getByRole('button', { name: 'Apply setting' }).click();
  await page.evaluate(() => window.huddleFixture.action('editor.save'));
  await page.waitForFunction(
    () =>
      window.huddleFixture.source().nodes.find((node) => node.id === 'script')?.parameters?.options,
  );
  assert.deepEqual(
    await page.evaluate(
      () => window.huddleFixture.source().nodes.find((node) => node.id === 'script').parameters,
    ),
    {
      prompt: { kind: 'literal', value: 'Review this worktree' },
      worktree: { kind: 'variable', name: 'targetWorktree' },
      enabled: { kind: 'literal', value: false },
      options: { kind: 'literal', value: { strict: true } },
    },
  );
  await editor.getByRole('button', { name: 'Add Result', exact: true }).click();
  // Closing one of two views preserves the shared unsaved manifest without review.
  await editor.getByRole('button', { name: 'Open definition', exact: true }).click();
  await page.waitForSelector('.monaco-editor');
  await tab.click({ position: { x: 10, y: 2 } });
  await tab.hover();
  await tab.getByRole('button', { name: 'Close Review graph', exact: true }).click();
  await tab.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('dialog').count(), 0);
  const sourceTab = page.locator('[data-pane-tab]').filter({ hasText: 'huddle.json' });
  await sourceTab.hover();
  await sourceTab.getByRole('button', { name: 'Close huddle.json', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByText('Discard changes to huddle.json?', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
  assert.equal(await sourceTab.count(), 1);
  await page.evaluate(() => window.huddleFixture.action('tab.close'));
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await sourceTab.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  assert.equal(
    await page.evaluate(() =>
      window.huddleFixture.requests.some((request) => /\/(start|run|resume)$/.test(request.path)),
    ),
    false,
  );
  console.log(
    'Huddle node/connection editing, undo/redo, shared source drafts, save conflicts and duplicate-view close review pass without execution.',
  );
} catch (error) {
  console.error('Browser errors:', errors);
  console.error(await page.locator('body').innerText());
  await page.screenshot({ path: '/tmp/puddle-huddle-editing-failure.png' });
  throw error;
} finally {
  await browser.close();
}
