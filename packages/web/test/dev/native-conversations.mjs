/* global window */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    new URL('/test/dev/workspace-fixture.html', process.env.PREVIEW_URL ?? 'http://localhost:5174/')
      .href,
  );
  await page.waitForSelector('.monaco-editor');
  await page.evaluate(() => window.workspaceFixture.releaseProjects());
  const { first, sessions } = await page.evaluate(() => window.workspaceFixture);
  await page.evaluate(
    ([project, session]) => window.workspaceFixture.visit(project, session),
    [first, sessions[0]],
  );
  await page.waitForFunction(
    (id) => window.workspaceFixture.bridge()?.capture.active_session === id,
    sessions[0],
  );
  const firstNew = 'd12cb167-a09d-4e2e-a667-99003ccf1111';
  const secondNew = 'd12cb167-a09d-4e2e-a667-99003ccf2222';
  for (const [source, target, cause] of [
    [sessions[0], firstNew, 'fork'],
    [firstNew, secondNew, 'clear'],
  ]) {
    await page.evaluate(
      ([source, target, cause]) => window.workspaceFixture.nativeCreation(source, target, cause),
      [source, target, cause],
    );
    await page.waitForFunction(
      (id) => window.workspaceFixture.bridge()?.capture.active_session === id,
      target,
    );
    const tree = await page.evaluate(() => window.workspaceFixture.bridge().capture.layout_tree);
    const serialised = JSON.stringify(tree);
    assert.ok(serialised.includes(source), 'Original terminal stays open');
    assert.ok(serialised.includes(target), 'New terminal opens');
    const leaves = (node) => (node.kind === 'leaf' ? [node] : node.children.flatMap(leaves));
    for (const leaf of leaves(tree)) {
      assert.notEqual(leaf.previewKey, `term:${source}`);
      assert.notEqual(leaf.previewKey, `term:${target}`);
    }
  }
  const tree = JSON.stringify(
    await page.evaluate(() => window.workspaceFixture.bridge().capture.layout_tree),
  );
  for (const id of [sessions[0], firstNew, secondNew]) assert.ok(tree.includes(id));
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.workspaceFixture.remove());
  console.log('Native fork/clear preserve original and new terminal tabs.');
} finally {
  await browser.close();
}
