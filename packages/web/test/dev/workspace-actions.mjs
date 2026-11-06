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
  await page.waitForFunction(() => window.workspaceFixture.state().layout_mode === 'project');
  const { sessions, first, second, profile } = await page.evaluate(() => window.workspaceFixture);
  // Project shortcuts must escape Monaco and switch the real workspace layout.
  await page.locator('.monaco-editor textarea').first().focus();
  await page.keyboard.press('Meta+1');
  await page.waitForFunction((p) => window.workspaceFixture.bridge()?.projectId === p, second);
  await page.keyboard.press('Meta+0');
  await page.waitForFunction((p) => window.workspaceFixture.bridge()?.projectId === p, first);
  await page.keyboard.press('Meta+9');
  assert.equal(await page.evaluate(() => window.workspaceFixture.bridge()?.projectId), first);
  const visit = async (project, session) => {
    await page.evaluate(([p, s]) => window.workspaceFixture.visit(p, s), [project, session]);
    await page.waitForFunction((p) => window.workspaceFixture.bridge()?.projectId === p, project);
  };
  await page.evaluate(() => window.workspaceFixture.action('tab.close'));
  await page.waitForFunction(
    (p) =>
      !JSON.stringify(window.workspaceFixture.state().project_layouts[p]).includes('README.md'),
    first,
  );
  await page.evaluate(() => window.workspaceFixture.action('tab.reopen'));
  await page.waitForFunction(
    (p) => JSON.stringify(window.workspaceFixture.state().project_layouts[p]).includes('README.md'),
    first,
  );
  // Selection belongs to the workspace, so presentation changes retain it.
  for (const id of sessions)
    await page
      .locator(`[data-sidebar-motion="sessions-item-${id}"]`)
      .click({ modifiers: ['Meta'] });
  assert.equal(
    await page.locator('[data-sidebar-motion^="sessions-item-"][aria-selected="true"]').count(),
    2,
  );
  await page.evaluate(() => window.workspaceFixture.action('sidebar.right'));
  await page.waitForFunction(() => window.workspaceFixture.state().sessions_collapsed);
  assert.equal(
    await page.locator('[data-sidebar-motion^="sessions-item-"][aria-selected="true"]').count(),
    2,
  );
  await page.evaluate(() => window.workspaceFixture.action('sidebar.right'));
  await page.waitForFunction(() => !window.workspaceFixture.state().sessions_collapsed);
  const resolveRoute = `/api/worktrees/${sessions[0]}/resolve`;
  await page.evaluate((route) => {
    window.workspaceFixture.hold('GET', route);
    window.openPathDone = false;
    void window.workspaceFixture.openPath('resolved-synthetic.md').then(() => {
      window.openPathDone = true;
    });
  }, resolveRoute);
  await page.waitForFunction(
    (route) =>
      window.workspaceFixture.requests.some((r) => r.method === 'GET' && r.path.startsWith(route)),
    resolveRoute,
  );
  await visit(second, sessions[1]);
  await visit(first, sessions[0]);
  await page.evaluate((route) => window.workspaceFixture.release('GET', route), resolveRoute);
  await page.waitForFunction(() => window.openPathDone);
  assert.ok(
    !JSON.stringify(await page.evaluate(() => window.workspaceFixture.state())).includes(
      'resolved-synthetic.md',
    ),
  );
  const createRoute = `/api/profiles/${profile}/untitled`;
  await page.evaluate((route) => {
    window.workspaceFixture.hold('POST', route);
    window.workspaceFixture.action('tab.newUntitled');
  }, createRoute);
  await page.waitForFunction(
    (route) =>
      window.workspaceFixture.requests.some((r) => r.method === 'POST' && r.path === route),
    createRoute,
  );
  await visit(second, sessions[1]);
  await visit(first, sessions[0]);
  await page.evaluate((route) => window.workspaceFixture.release('POST', route), createRoute);
  await page.waitForFunction(() =>
    window.workspaceFixture.requests.some(
      (r) => r.method === 'DELETE' && r.path.endsWith('/untitled-1.md'),
    ),
  );
  assert.ok(
    !JSON.stringify(await page.evaluate(() => window.workspaceFixture.state())).includes(
      'untitled-1.md',
    ),
  );
  // A saved draft replaces its original tab even if another project is now visible.
  await page.evaluate(() => window.workspaceFixture.action('tab.newUntitled'));
  await page.waitForFunction(() =>
    JSON.stringify(window.workspaceFixture.state()).includes('untitled-2.md'),
  );
  await page.evaluate(() =>
    window.workspaceFixture.saveDraft({
      name: 'untitled-2.md',
      content: 'Synthetic saved content',
    }),
  );
  await page.getByLabel('Worktree-relative path').fill('saved-synthetic.md');
  const fileRoute = `/api/worktrees/${sessions[0]}/file`;
  await page.evaluate((route) => window.workspaceFixture.hold('PUT', route), fileRoute);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(
    (route) =>
      window.workspaceFixture.requests.some((r) => r.method === 'PUT' && r.path.startsWith(route)),
    fileRoute,
  );
  await visit(second, sessions[1]);
  await page.evaluate((route) => window.workspaceFixture.release('PUT', route), fileRoute);
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const saved = await page.evaluate(() => window.workspaceFixture.state());
  assert.ok(JSON.stringify(saved.project_layouts[first]).includes('saved-synthetic.md'));
  assert.ok(!JSON.stringify(saved).includes('untitled-2.md'));
  assert.ok(!JSON.stringify(saved.project_layouts[second]).includes('saved-synthetic.md'));
  // A rename may finish after the old editor has flushed and released its model.
  await visit(first, sessions[0]);
  const readme = page
    .locator('[data-pane-drag-handle] [aria-roledescription="draggable"]')
    .filter({ hasText: 'README.md' });
  await readme.click();
  await page.waitForSelector('.monaco-editor');
  await page.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    monaco.editor
      .getModels()
      .find((m) => m.uri.path.endsWith('README.md'))
      .setValue('Dirty text during delayed rename');
  });
  const renameRoute = `/api/worktrees/${sessions[0]}/rename`;
  await page.evaluate((route) => window.workspaceFixture.hold('POST', route), renameRoute);
  await readme.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Rename/ }).click();
  await page.getByRole('textbox', { name: 'Rename README.md' }).fill('renamed-synthetic.md');
  await page.getByRole('textbox', { name: 'Rename README.md' }).press('Enter');
  await page.waitForFunction(
    (route) =>
      window.workspaceFixture.requests.some((r) => r.method === 'POST' && r.path === route),
    renameRoute,
  );
  await visit(second, sessions[1]);
  await page.evaluate((route) => window.workspaceFixture.release('POST', route), renameRoute);
  await page.waitForFunction(
    (p) =>
      JSON.stringify(window.workspaceFixture.state().project_layouts[p]).includes(
        'renamed-synthetic.md',
      ),
    first,
  );
  const draft = await page.evaluate(async (session) => {
    const { loadDraft } = await import('/src/lib/persistence/drafts.ts');
    return loadDraft(session, 'renamed-synthetic.md');
  }, sessions[0]);
  assert.equal(draft.content, 'Dirty text during delayed rename');
  assert.equal(await page.evaluate(() => window.workspaceFixture.bridge().projectId), second);
  // A late archive removes its original terminal without navigating back.
  await visit(first, sessions[0]);
  const archiveRoute = `/api/sessions/${sessions[0]}/archive`;
  await page.evaluate((route) => window.workspaceFixture.hold('POST', route), archiveRoute);
  await page.getByRole('button', { name: 'Archive session', exact: true }).click({ force: true });
  await page.waitForFunction(
    (route) =>
      window.workspaceFixture.requests.some((r) => r.method === 'POST' && r.path === route),
    archiveRoute,
  );
  await visit(second, sessions[1]);
  await page.evaluate((route) => window.workspaceFixture.release('POST', route), archiveRoute);
  await page.waitForFunction(
    ([p, id]) => {
      const hasTerminal = (tree) =>
        tree?.kind === 'leaf'
          ? tree.tabs.some((ref) => ref.type === 'terminal' && ref.session === id)
          : tree?.children.some(hasTerminal);
      return !hasTerminal(window.workspaceFixture.state().project_layouts[p].layout_tree);
    },
    [first, sessions[0]],
  );
  assert.equal(await page.evaluate(() => window.workspaceFixture.bridge().projectId), second);
  assert.deepEqual(errors, []);
  console.log(
    'Closed tabs reopen; selection survives rail changes; delayed path, draft, rename and archive operations preserve project ownership and dirty text.',
  );
} finally {
  await browser.close();
}
