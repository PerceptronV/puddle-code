/* global window, document */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error.stack);
  });
  await page.goto(
    new URL('/test/dev/workspace-fixture.html', process.env.PREVIEW_URL ?? 'http://localhost:5174/')
      .href,
  );
  await page.waitForSelector('.monaco-editor');
  assert.equal(
    await page.evaluate(() => window.workspaceFixture.state().layout_mode),
    'profile',
    'conversion waits for full project catalogue',
  );
  await page.evaluate(() => window.workspaceFixture.releaseProjects());
  await page.waitForFunction(() => window.workspaceFixture.state().layout_mode === 'project');
  const initial = await page.evaluate(() => window.workspaceFixture.state());
  assert.equal(Object.keys(initial.project_layouts).length, 2);
  await page.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    const model = monaco.editor.getModels().find((m) => m.uri.path.endsWith('README.md'));
    model.setValue('Synthetic dirty text preserved across projects');
    window.workspaceFixture.save();
    window.workspaceFixture.visit(
      window.workspaceFixture.first,
      window.workspaceFixture.sessions[0],
    );
  });
  await page.waitForSelector('[data-notification-session="00000000-0000-4000-8000-000000000001"]');
  await page.evaluate(() => {
    window.firstTerminal = document.querySelector(
      '[data-notification-session="00000000-0000-4000-8000-000000000001"]',
    );
    window.workspaceFixture.visit(
      window.workspaceFixture.second,
      window.workspaceFixture.sessions[1],
    );
  });
  await page.waitForSelector('[data-notification-session="00000000-0000-4000-8000-000000000002"]');
  assert.equal(
    await page.evaluate(() => window.firstTerminal.isConnected),
    true,
    'parked terminal remains mounted',
  );
  await page.evaluate(() =>
    window.workspaceFixture.visit(
      window.workspaceFixture.first,
      window.workspaceFixture.sessions[0],
    ),
  );
  await page.waitForSelector('[data-notification-session="00000000-0000-4000-8000-000000000001"]');
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector(
          '[data-notification-session="00000000-0000-4000-8000-000000000001"]',
        ) === window.firstTerminal,
    ),
    true,
  );
  await page
    .locator('[data-pane-drag-handle] [aria-roledescription="draggable"]')
    .filter({ hasText: 'README.md' })
    .click();
  await page.waitForSelector('.monaco-editor');
  assert.equal(
    await page.evaluate(async () => {
      const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
      return monaco.editor
        .getModels()
        .find((m) => m.uri.path.endsWith('README.md'))
        .getValue();
    }),
    'Synthetic dirty text preserved across projects',
  );
  await page.evaluate(() => window.workspaceFixture.projectMode(false));
  await page.waitForFunction(() => window.workspaceFixture.state().layout_mode === 'profile');
  assert.equal(await page.evaluate(() => window.firstTerminal.isConnected), true);
  assert.equal(await page.evaluate(() => window.workspaceFixture.load()), true);
  await page.waitForFunction(() => window.workspaceFixture.state().layout_mode === 'project');
  assert.equal(await page.evaluate(() => window.workspaceFixture.bridge().scope), 'project');
  const restored = await page.evaluate(() => window.workspaceFixture.state());
  assert.ok(
    restored.project_layouts['0000000003'].layout_tree,
    'loading one project preserves another project slice',
  );
  assert.equal(await page.evaluate(() => window.firstTerminal.isConnected), true);
  assert.deepEqual(errors, []);
  console.log(
    'Real workspace preserves terminal portals and dirty buffers through project visits, delayed catalogue, mode conversion and saved-layout loading.',
  );
} finally {
  await browser.close();
}
