/* global window */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(
    new URL('/test/huddle/fixture.html', process.env.PREVIEW_URL ?? 'http://localhost:5174/').href,
  );
  await page.waitForFunction(() => !!window.huddleFixture);
  await page.evaluate(() => window.huddleFixture.releaseProjects());
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByRole('button', { name: 'Review graph', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Huddle editor' });
  const inspector = editor.getByRole('complementary', { name: 'Node inspector' });
  const add = async (name) => {
    await editor.getByRole('button', { name: 'Add node', exact: true }).click();
    await editor.getByRole('button', { name: `Add ${name}`, exact: true }).click();
    await editor.getByRole('button', { name: 'Add node', exact: true }).click();
    await editor.getByRole('button', { name: `${name} event`, exact: true }).click();
  };
  const setText = async (name, value) => {
    const group = inspector.getByRole('group', { name, exact: true });
    await group.getByRole('textbox').fill(value);
    await group.getByRole('button', { name: 'Apply setting' }).click();
  };
  await add('Git');
  const worktree = inspector.getByRole('group', { name: 'Worktree', exact: true });
  assert.equal(await worktree.getByLabel('Worktree *', { exact: true }).inputValue(), '');
  await worktree.getByLabel('Worktree *', { exact: true }).selectOption('/preview/puddle');
  await worktree.getByRole('button', { name: 'Apply setting' }).click();
  assert.equal(
    await inspector
      .getByRole('group', { name: 'Repository directory', exact: true })
      .getByRole('textbox')
      .inputValue(),
    '.',
  );
  await setText('Repository directory', 'nested');
  await setText('Ref globs', '["refs/tags/**"]');
  const debounce = inspector.getByRole('group', { name: 'Debounce (milliseconds)', exact: true });
  assert.equal(await debounce.getByRole('spinbutton').inputValue(), '250');
  await debounce.getByRole('spinbutton').fill('150');
  await debounce.getByRole('button', { name: 'Apply setting' }).click();
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() =>
    window.huddleFixture.source().nodes.some((node) => node.id === 'git'),
  );
  assert.deepEqual(
    await page.evaluate(
      () => window.huddleFixture.source().nodes.find((node) => node.id === 'git').parameters,
    ),
    {
      worktree: { kind: 'literal', value: '/preview/puddle' },
      repository: { kind: 'literal', value: 'nested' },
      refs: { kind: 'literal', value: ['refs/tags/**'] },
      debounceMs: { kind: 'literal', value: 150 },
    },
  );
  if (process.env.PUDDLE_HUDDLE_SCREENSHOTS) {
    await worktree.scrollIntoViewIfNeeded();
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => window.huddleFixture.theme(theme), theme);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `/tmp/puddle-huddle-git-${theme}.png` });
    }
  }
  assert.equal(
    await page.evaluate(() =>
      window.huddleFixture.requests.some((request) =>
        /\/(start|apply|run|rearm)$/.test(request.path),
      ),
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log('Git settings require an explicit worktree and save without arming.');
} catch (error) {
  console.error(await page.locator('body').innerText());
  await page.screenshot({ path: '/tmp/puddle-huddle-git-failure.png' });
  throw error;
} finally {
  await browser.close();
}
