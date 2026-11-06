/* global window */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./lifecycle-entry.tsx', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  loader: { '.css': 'empty' },
  plugins: [
    {
      name: 'omit-editor-buffers',
      setup(build) {
        // This fixture checks tab resolution and tooltip context, not Monaco's
        // separately tested dirty-buffer/close controls.
        build.onResolve({ filter: /\/lazy-editor-parts$/ }, (args) => ({
          path: args.path,
          namespace: 'editor-stub',
        }));
        build.onLoad({ filter: /.*/, namespace: 'editor-stub' }, () => ({
          contents:
            'export const LazyEditorDirtyDot = () => null; export const LazyEditorTabClose = () => null;',
        }));
      },
    },
  ],
});
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const mutations = [],
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://session.test/**', (route) => {
    const request = route.request();
    if (request.url().endsWith('/'))
      return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    if (request.method() !== 'GET') mutations.push(new URL(request.url()).pathname);
    const path = new URL(request.url()).pathname;
    return route.fulfill({
      json:
        path.endsWith('/accounts') || path.endsWith('/projects')
          ? []
          : path.endsWith('/version')
            ? { protocol: { major: 26, minor: 0 } }
            : {},
    });
  });
  await page.goto('http://session.test/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const show = async (surface, patch, connected = true) => {
    await page.evaluate(({ surface, patch, connected }) => window.show(surface, patch, connected), {
      surface,
      patch,
      connected,
    });
    await page.waitForTimeout(50);
  };
  for (const flag of ['worktree_missing', 'conversation_missing']) {
    const patch = { status: 'interrupted', [flag]: true };
    await show('mobile', patch);
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeDisabled();
    await expect(page.getByText(/resume unavailable/, { exact: false })).toBeVisible();
    await show('tab', patch);
    await expect(page.getByRole('button', { name: 'Resume session' })).toBeDisabled();
    await show('overlay', patch);
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
    await show('desktop', patch);
    await page.getByRole('button', { name: 'Session actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Resume', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(mutations, []);
  await show('mobile', { status: 'running', worktree_missing: true, conversation_missing: true });
  await page.getByRole('button', { name: 'Stop session' }).click();
  await expect.poll(() => mutations.at(-1)).toMatch(/\/kill$/);
  await show('mobile', { status: 'exited' }, false);
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeDisabled();
  await show('mobile', { status: 'exited' });
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect.poll(() => mutations.at(-1)).toMatch(/\/resume$/);
  await show('tab', { status: 'exited' });
  await expect(page.getByRole('button', { name: 'Resume session' })).toBeEnabled();
  await show('overlay', { status: 'exited' });
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  await show('desktop', { status: 'exited' });
  await page.getByRole('button', { name: 'Session actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Resume', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await show('mobile', { status: 'archived' });
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Restore session' })).toBeEnabled();
  // Exercise the actual strip's session resolution, path labels and tooltip
  // context for worktree files, external roots, drafts and missing sessions.
  for (const [kind, missing, label, context] of [
    ['terminal', false, 'Synthetic session', true],
    ['file', false, '/synthetic/project/src/example.txt', true],
    ['external', false, '/synthetic/external/src/example.txt', false],
    ['untitled', false, 'Untitled-1', false],
    ['file', true, 'src/example.txt', false],
    ['terminal', true, '00000000-0000-4000-8000-000000000002', false],
  ]) {
    await page.mouse.move(380, 800);
    await page.evaluate(({ kind, missing }) => window.showStrip(kind, missing), { kind, missing });
    const tab = page.locator('[data-pane-tab]');
    await expect(tab).toHaveAttribute('aria-label', label);
    await tab.focus();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toContainText(label);
    if (context) await expect(tooltip).toContainText('main');
    else await expect(tooltip).not.toContainText('main');
  }
  assert.deepEqual(errors, []);
  console.log(
    'Lifecycle actions agree; tab paths and tooltip context preserve worktree, external, draft and missing-session behaviour.',
  );
} finally {
  await browser.close();
}
