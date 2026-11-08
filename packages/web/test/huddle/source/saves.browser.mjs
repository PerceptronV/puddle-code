/* global window, document */
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(20_000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const waitAsync = (predicate) =>
  expect.poll(() => page.evaluate(predicate), { timeout: 20_000 }).toBeTruthy();
const editor = page.getByRole('region', { name: 'Huddle editor' });
const modelEdit = async (file, change) =>
  page.evaluate(
    async ({ file, change }) => {
      const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
      const model = monaco.editor
        .getModels()
        .find(
          (item) =>
            item.uri.scheme !== 'puddle-disk' &&
            item.uri.path.endsWith(`/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/${file}`),
        );
      const value = { ...JSON.parse(model.getValue()), ...change };
      model.pushEditOperations(
        [],
        [{ range: model.getFullModelRange(), text: JSON.stringify(value, null, 2) + '\n' }],
        () => null,
      );
    },
    { file, change },
  );
const save = () => editor.getByRole('button', { name: 'Save', exact: true }).click();
const compare = async () => {
  await editor.getByRole('button', { name: 'Compare', exact: true }).click();
  await editor.getByRole('button', { name: 'Keep mine', exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === 'Keep mine',
      )?.disabled,
  );
};
const puts = () =>
  page.evaluate(
    () =>
      window.huddleFixture.requests.filter(
        (request) => request.method === 'PUT' && request.path.endsWith('/source'),
      ).length,
  );
try {
  await page.goto(
    new URL(
      '/test/huddle/fixture.html?source-saves',
      process.env.PREVIEW_URL ?? 'http://127.0.0.1:5189/',
    ).href,
  );
  await page.waitForFunction(() => !!window.huddleFixture);
  await page.evaluate(() => window.huddleFixture.releaseProjects());
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByRole('button', { name: 'Review graph', exact: true }).click();
  await editor.getByRole('button', { name: 'Add node', exact: true }).click();
  await editor
    .getByLabel('Local component contract', { exact: true })
    .fill('nodes/review/node.json');
  await editor.getByRole('button', { name: 'Add local node', exact: true }).click();
  await modelEdit('layout.json', { nodes: { run: { x: 80, y: 120 } } });
  await save();
  await editor.getByText('Unsaved changes', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await puts(), 2, 'manifest then layout follow only acknowledged sibling writes');
  assert.equal(
    await page.evaluate(() =>
      window.huddleFixture.requests.some(
        (request) => request.method === 'PUT' && request.path.endsWith('/file'),
      ),
    ),
    false,
  );

  await modelEdit('huddle.json', { name: 'My draft' });
  await page.evaluate(() =>
    window.huddleFixture.sourceControls.script('// external script, unchanged manifest mtime'),
  );
  await save();
  await compare();
  await editor.locator('summary').filter({ hasText: 'Huddle source review' }).click();
  await editor.getByRole('button', { name: 'nodes/review/run.ts', exact: true }).click();
  await editor.getByText('// external script, unchanged manifest mtime', { exact: true }).waitFor();
  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => window.huddleFixture.theme(theme), theme);
    await page.screenshot({ path: `/tmp/huddle-source-review-${theme}.png` });
  }
  await page.evaluate(() =>
    window.huddleFixture.sourceControls.script('// changed again after review'),
  );
  await editor.getByRole('button', { name: 'Keep mine', exact: true }).click();
  await editor.getByRole('button', { name: 'Compare', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.huddleFixture.source().name), 'Review graph');
  await compare();
  await editor.getByRole('button', { name: 'Keep mine', exact: true }).click();
  await page.waitForFunction(() => window.huddleFixture.source().name === 'My draft');
  await editor.getByText('Unsaved changes', { exact: true }).waitFor({ state: 'hidden' });

  // The source tab shares the same guarded buffer and draft persistence.
  await editor.getByRole('button', { name: 'Open definition', exact: true }).click();
  await page.waitForSelector('.monaco-editor');
  await modelEdit('huddle.json', { name: 'Lost reply draft' });
  await page.evaluate(() => window.huddleFixture.sourceControls.loseNext());
  await page.evaluate(() => window.huddleFixture.action('editor.save'));
  await page.waitForFunction(() => window.huddleFixture.source().name === 'Lost reply draft');
  const prior = await puts();
  await page.evaluate(() => window.huddleFixture.action('editor.save'));
  assert.equal(await puts(), prior, 'uncertain save is not automatically repeated');
  await page
    .locator('[data-pane-tab="huddle:00000000-0000-4000-8000-000000000003"]')
    .click({ position: { x: 10, y: 2 } });
  await compare();
  await editor.getByRole('button', { name: 'Take the disk version', exact: true }).click();
  await editor.getByText('Unsaved changes', { exact: true }).waitFor({ state: 'hidden' });

  // Acknowledging one version must not erase the draft typed while its request was held.
  await modelEdit('huddle.json', { name: 'First version' });
  await page.evaluate(() => window.huddleFixture.sourceControls.hold());
  await save();
  await page.waitForFunction(
    (prior) =>
      window.huddleFixture.requests.filter(
        (request) => request.method === 'PUT' && request.path.endsWith('/source'),
      ).length > prior,
    prior,
  );
  await modelEdit('huddle.json', { name: 'Typed during save' });
  await page.evaluate(() => window.huddleFixture.sourceControls.release());
  await page.waitForFunction(() => window.huddleFixture.source().name === 'First version');
  await waitAsync(async () => {
    const { loadDraft } = await import('/src/lib/persistence/drafts.ts');
    const draft = await loadDraft(
      window.huddleFixture.saved,
      '.puddle/huddle/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/huddle.json',
    );
    return draft?.content.includes('Typed during save') && draft.baseRevision?.digest;
  });
  await save();
  await page.waitForFunction(() => window.huddleFixture.source().name === 'Typed during save');
  await editor.getByText('Unsaved changes', { exact: true }).waitFor({ state: 'hidden' });

  // Broken source is repairable only after an explicit comparison, with the reviewed file mtime.
  await modelEdit('huddle.json', { name: 'Repaired version' });
  await page.evaluate(() => window.huddleFixture.sourceControls.invalid());
  await save();
  // A failed capture must become a reviewable conflict, never leave Save in an endless rejection loop.
  await compare();
  await editor.getByText('The huddle cannot be captured.', { exact: false }).waitFor();
  await editor.getByRole('button', { name: 'Keep mine', exact: true }).click();
  await page.waitForFunction(() => window.huddleFixture.source().name === 'Repaired version');
  const repairs = await page.evaluate(() =>
    window.huddleFixture.requests.filter(
      (request) => request.method === 'PUT' && request.path.endsWith('/file'),
    ),
  );
  assert.equal(repairs.length, 1);
  assert.equal(typeof repairs[0].body.expected_mtime_ms, 'number');

  // Actual IndexedDB restoration: the fixture resets disk on reload, so the
  // recovered draft must retain its previous capture rather than adopt fresh source.
  await editor.getByText('Unsaved changes', { exact: true }).waitFor({ state: 'hidden' });
  await waitAsync(async () => {
    const { savedRevision, bufferKey } =
      await import('/src/features/editor/buffers/buffer-store.ts');
    return !!savedRevision(
      bufferKey(
        window.huddleFixture.saved,
        '.puddle/huddle/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/huddle.json',
      ),
    );
  });
  await modelEdit('huddle.json', { name: 'Recovered captured draft' });
  await waitAsync(async () => {
    const { loadDraft } = await import('/src/lib/persistence/drafts.ts');
    const draft = await loadDraft(
      window.huddleFixture.saved,
      '.puddle/huddle/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/huddle.json',
    );
    return draft?.content.includes('Recovered captured draft') && !!draft.baseRevision;
  });
  const reopen = async () => {
    await page.reload();
    await page.waitForFunction(() => !!window.huddleFixture);
    await page.evaluate(() => window.huddleFixture.releaseProjects());
    await page.getByRole('button', { name: 'New huddle', exact: true }).click();
    await page.getByRole('button', { name: 'Review graph', exact: true }).click();
    await page.getByRole('button', { name: 'Restore draft', exact: true }).click();
  };
  await reopen();
  await editor.getByText('Recovered captured draft', { exact: true }).waitFor();
  await save();
  await compare();
  assert.equal(await page.evaluate(() => window.huddleFixture.source().name), 'Review graph');
  await editor.getByRole('button', { name: 'Keep mine', exact: true }).click();
  await page.waitForFunction(
    () => window.huddleFixture.source().name === 'Recovered captured draft',
  );
  await editor.getByText('Unsaved changes', { exact: true }).waitFor({ state: 'hidden' });

  await page.evaluate(async () => {
    const { saveDraft } = await import('/src/lib/persistence/drafts.ts');
    await saveDraft(
      window.huddleFixture.saved,
      '.puddle/huddle/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/huddle.json',
      JSON.stringify({ ...window.huddleFixture.source(), name: 'Recovered legacy draft' }),
      0,
    );
  });
  await reopen();
  await editor.getByText('Recovered legacy draft', { exact: true }).waitFor();
  await save();
  assert.equal(await puts(), 0, 'an old draft with no capture must not publish before review');
  await compare();
  await editor.locator('summary').filter({ hasText: 'Huddle source review' }).click();
  await editor.getByText('This draft has no captured baseline.', { exact: false }).waitFor();
  await editor.getByRole('button', { name: 'Keep mine', exact: true }).click();
  await page.waitForFunction(() => window.huddleFixture.source().name === 'Recovered legacy draft');

  assert.equal(
    await page.evaluate(() =>
      window.huddleFixture.requests.some((request) => /\/(start|run|resume)$/.test(request.path)),
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    'Captured huddle saves, dependency conflicts, guarded Keep mine, source tab sharing, unknown outcomes, in-flight typing explicit repair and IndexedDB recovery pass.',
  );
} catch (error) {
  console.error('Browser errors:', errors);
  console.error(
    'Retained draft:',
    await page.evaluate(async () => {
      const { loadDraft } = await import('/src/lib/persistence/drafts.ts');
      const draft = await loadDraft(
        window.huddleFixture.saved,
        '.puddle/huddle/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/huddle.json',
      );
      return draft && { name: JSON.parse(draft.content).name, digest: draft.baseRevision?.digest };
    }),
  );
  console.error(await page.locator('body').innerText());
  await page.screenshot({ path: '/tmp/huddle-source-saves-failure.png' });
  throw error;
} finally {
  await browser.close();
}
