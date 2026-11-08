/* global window */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(
    new URL(
      '/test/huddle/fixture.html?agent-templates',
      process.env.PREVIEW_URL ?? 'http://localhost:5174/',
    ).href,
  );
  await page.waitForFunction(() => !!window.huddleFixture);
  await page.evaluate(() => window.huddleFixture.releaseProjects());
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByRole('button', { name: 'Review graph', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Huddle editor' });
  await editor.getByRole('button', { name: 'Add node', exact: true }).click();
  await editor.getByRole('button', { name: 'Add Prompt agent', exact: true }).click();
  await editor
    .getByRole('button', { name: 'Prompt agent value completed turn', exact: true })
    .waitFor();
  await editor.getByRole('button', { name: 'Add Review agent', exact: true }).click();
  const reviewer = editor.getByRole('button', {
    name: 'Review agent value completed turn',
    exact: true,
  });
  await reviewer.waitFor();
  assert.equal(await page.evaluate(() => window.huddleFixture.source().nodes.length), 2);
  for (const [name, id] of [
    ['Prompt agent', '00000000-0000-4000-8000-000000000005'],
    ['Review agent', '00000000-0000-4000-8000-000000000006'],
  ]) {
    await editor.getByRole('button', { name: `${name} value completed turn`, exact: true }).click();
    const inspector = editor.getByRole('complementary', { name: 'Node inspector' });
    const worktree = inspector.getByRole('group', { name: 'Worktree', exact: true });
    await worktree.getByLabel('Worktree *', { exact: true }).selectOption('/preview/puddle');
    await worktree.getByRole('button', { name: 'Apply setting' }).click();
    const agent = inspector.getByRole('group', { name: 'Agent session', exact: true });
    await agent.getByLabel('Agent session *', { exact: true }).selectOption(id);
    await agent.getByRole('button', { name: 'Apply setting' }).click();
    const prompt = inspector.getByRole('group', { name: 'Prompt', exact: true });
    assert.ok((await prompt.getByRole('textbox').inputValue()).includes('{{input}}'));
    if (name === 'Prompt agent') {
      await prompt.getByRole('button', { name: 'Clear setting' }).click();
      assert.equal(await prompt.getByRole('textbox').inputValue(), '{{input}}');
      await prompt.getByRole('textbox').fill('Implement the requested changes:\n{{input}}');
      await prompt.getByRole('button', { name: 'Apply setting' }).click();
    }
  }
  await editor.getByRole('button', { name: 'Add node', exact: true }).click();
  await editor.getByRole('button', { name: 'Connections', exact: true }).click();
  await editor.getByRole('button', { name: 'Disconnect result-edge', exact: true }).click();
  for (const [from, to] of [
    ['run.event', 'prompt-agent.value'],
    ['prompt-agent.completed', 'review-agent.value'],
    ['review-agent.completed', 'result.value'],
    ['review-agent.completed', 'prompt-agent.value'],
  ]) {
    await editor.getByLabel('Output', { exact: true }).selectOption({ label: from });
    await editor.getByLabel('Input', { exact: true }).selectOption({ label: to });
    await editor.getByRole('button', { name: 'Connect', exact: true }).click();
  }
  const feedback = editor
    .locator('div')
    .filter({ has: page.getByText('review-agent.completed → prompt-agent.value', { exact: true }) })
    .filter({ has: page.getByRole('checkbox', { name: 'Bounded feedback' }) })
    .last();
  await feedback.getByRole('checkbox', { name: 'Bounded feedback' }).check();
  await feedback.getByLabel('Continue while', { exact: true }).selectOption({ label: 'complete' });
  await feedback.getByLabel('Feedback condition value').selectOption('false');
  await feedback.getByLabel('Maximum rounds').fill('3');
  await feedback.getByLabel('Maximum rounds').press('Enter');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() =>
    window.huddleFixture.source().edges.some((edge) => edge.feedback?.maxRounds === 3),
  );
  const source = await page.evaluate(() => window.huddleFixture.source());
  assert.deepEqual(source.edges.at(-1).feedback, {
    maxRounds: 3,
    while: { path: ['complete'], equals: false },
  });
  assert.equal(
    source.nodes.find((node) => node.id === 'prompt-agent').parameters.agent.value,
    '00000000-0000-4000-8000-000000000005',
  );
  assert.equal(
    source.nodes.find((node) => node.id === 'review-agent').parameters.agent.value,
    '00000000-0000-4000-8000-000000000006',
  );
  const files = await page.evaluate(() => window.huddleFixture.componentFiles());
  assert.equal(Object.keys(files).filter((path) => path.endsWith('/run.ts')).length, 2);
  assert.ok(Object.values(files).some((file) => file.content.includes('formatPrompt')));
  await editor.getByRole('button', { name: 'Connections', exact: true }).click();
  await reviewer.click();
  await editor.getByRole('button', { name: 'Open script', exact: true }).click();
  await page.waitForSelector('.monaco-editor');
  await page.waitForFunction(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    return monaco.editor
      .getModels()
      .some(
        (model) =>
          model.uri.path.endsWith('/run.ts') && model.getValue().includes('complete: z.boolean()'),
      );
  });
  const tab = page.locator('[data-pane-tab="huddle:00000000-0000-4000-8000-000000000003"]');
  await tab.click({ position: { x: 10, y: 2 } });
  await reviewer.click();
  await editor.getByRole('button', { name: 'Open contract', exact: true }).click();
  await page.waitForFunction(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    return monaco.editor.getModels().some((model) => model.uri.path.endsWith('/node.json'));
  });
  await page.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    const model = monaco.editor.getModels().find((item) => item.uri.path.endsWith('/node.json'));
    model.pushEditOperations(
      [],
      [{ range: model.getFullModelRange(), text: '{"invalid":true}' }],
      () => null,
    );
    window.huddleFixture.action('editor.save');
  });
  await page.waitForFunction(() =>
    Object.values(window.huddleFixture.componentFiles()).some(
      (file) => file.content === '{"invalid":true}',
    ),
  );
  await tab.click({ position: { x: 10, y: 2 } });
  await editor
    .getByRole('button', { name: 'review-agent Unresolved component', exact: true })
    .click();
  assert.equal(await editor.getByRole('button', { name: 'Open script', exact: true }).count(), 0);
  assert.equal(
    await page.evaluate(() =>
      window.huddleFixture.requests.some((request) => /\/(start|run|resume)$/.test(request.path)),
    ),
    false,
  );
  assert.deepEqual(errors, []);
  await page.goto(
    new URL(
      '/test/huddle/fixture.html?old-templates',
      process.env.PREVIEW_URL ?? 'http://localhost:5174/',
    ).href,
  );
  await page.waitForFunction(() => !!window.huddleFixture);
  await page.evaluate(() => window.huddleFixture.releaseProjects());
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByRole('button', { name: 'Review graph', exact: true }).click();
  await editor.getByRole('button', { name: 'Add node', exact: true }).click();
  await editor.getByRole('button', { name: 'Add Run', exact: true }).waitFor();
  assert.equal(
    await editor.getByRole('button', { name: 'Add Prompt agent', exact: true }).count(),
    0,
  );
  assert.equal(
    await editor.getByRole('button', { name: 'Add Review agent', exact: true }).count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    'Editable agent templates, resource bindings, prompt settings, bounded feedback and Open script pass without execution.',
  );
} catch (error) {
  console.error('Browser errors:', errors);
  console.error(await page.locator('body').innerText());
  await page.screenshot({ path: '/tmp/puddle-huddle-templates-failure.png' });
  throw error;
} finally {
  await browser.close();
}
