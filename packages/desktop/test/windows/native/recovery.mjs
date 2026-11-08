/* global window, performance, Response */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/** Missing resources are synthetic; the window, retained draft and retry UI are real. */
export async function checkMissingResources(application, page, expect, dirtyText) {
  await page.evaluate(async () => {
    const loaded = (path) =>
      performance
        .getEntriesByType('resource')
        .find((entry) => new URL(entry.name).pathname === path)?.name ?? path;
    const { browserTransport } = await import(loaded('/src/lib/transport/browser-transport.ts'));
    const { queryClient } = await import(loaded('/src/lib/queries/client.ts'));
    const transport = browserTransport();
    const original = transport.request;
    window.nativeMissing = { file: true, project: false, sessions: true, mutations: 0 };
    transport.request = (method, url, body) => {
      const path = new URL(url, window.location.origin).pathname;
      if (method !== 'GET' && (path.endsWith('/file') || path.includes('/untitled/')))
        window.nativeMissing.mutations++;
      if (
        (window.nativeMissing.file && path.endsWith('/file')) ||
        (window.nativeMissing.project && path === '/api/projects/0000000002')
      )
        return Promise.resolve(
          Response.json(
            { error: 'not_found', message: 'Fixture resource unavailable' },
            { status: 404 },
          ),
        );
      if (window.nativeMissing.project && path === '/api/projects')
        return Promise.resolve(Response.json([]));
      if (window.nativeMissing.sessions && path === '/api/sessions')
        return Promise.resolve(Response.json([]));
      if (window.nativeMissing.sessions && path === '/api/projects/0000000002')
        return original
          .call(transport, method, url, body)
          .then(async (response) => Response.json({ ...(await response.json()), sessions: [] }));
      return original.call(transport, method, url, body);
    };
    const { suspendDesktopContent } = await import(
      loaded('/src/features/windows/window-context.tsx')
    );
    suspendDesktopContent(true);
    queryClient.setQueryData(['sessions', 'all'], []);
    queryClient.setQueryData(['project', '0000000002'], (detail) => ({ ...detail, sessions: [] }));
    suspendDesktopContent(false);
    await queryClient.resetQueries({ queryKey: ['wt-file'] });
  });
  const recovered = page.getByRole('textbox', {
    name: 'Recovered text for README.md',
    exact: true,
  });
  await expect(recovered).toHaveValue(dirtyText);
  await expect(recovered).toHaveAttribute('readonly', '');
  if (process.env.PUDDLE_RECOVERY_SCREENSHOT)
    await page.screenshot({ path: process.env.PUDDLE_RECOVERY_SCREENSHOT });
  await expect(page.locator('[data-pane-tab]')).toHaveCount(2);
  await page.locator('[data-pane-tab^="term:"]').click();
  await expect(
    page.getByText('Session unavailable — this tab is retained for reconnection.', { exact: true }),
  ).toBeVisible();
  await page.locator('[data-pane-tab^="editor:"]').click({ position: { x: 10, y: 12 } });
  await expect(recovered).toHaveValue(dirtyText);
  // Use the real existing tab-close policy even though no Monaco model is available.
  const close = page.getByRole('button', { name: 'Close README.md', exact: true });
  await close.focus();
  await close.press('Enter');
  await expect(page.getByRole('dialog')).toContainText('Discard changes to README.md?');
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(recovered).toHaveValue(dirtyText);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await recovered.focus();
  await page.keyboard.press('Meta+w');
  await expect(page.getByRole('dialog')).toContainText('Discard changes to README.md?');
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(recovered).toHaveValue(dirtyText);
  await expect(page.locator('[data-pane-tab]')).toHaveCount(2);

  // Contain Electron's real download within the fixture's temporary home.
  const native = await application.browserWindow(page);
  const path = await native.evaluate((win) => {
    const output = process.env.PUDDLE_NATIVE_TEST_HOME + '/recovered.txt';
    win.nativeRecoveryDownload = 'pending';
    win.webContents.session.once('will-download', (_event, item) => {
      item.setSavePath(output);
      item.once('done', (_event, state) => {
        win.nativeRecoveryDownload = state;
      });
    });
    return output;
  });
  await page.getByRole('button', { name: 'Download recovered text', exact: true }).click();
  await expect.poll(() => native.evaluate((win) => win.nativeRecoveryDownload)).toBe('completed');
  assert.equal(await readFile(path, 'utf8'), dirtyText);
  console.log('Missing-session tabs, discard cancellation and native recovery download passed.');

  await page.evaluate(() => {
    window.nativeMissing.file = false;
  });
  await page.getByRole('button', { name: 'Retry original', exact: true }).click();
  await expect(recovered).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
        return monaco.editor.getEditors().map((editor) => editor.getModel()?.getValue());
      }),
    )
    .toContain(dirtyText);

  await page.evaluate(async () => {
    window.nativeMissing.project = true;
    const path = '/src/lib/queries/client.ts';
    const { queryClient } = await import(
      performance
        .getEntriesByType('resource')
        .find((entry) => new URL(entry.name).pathname === path)?.name ?? path
    );
    await queryClient.resetQueries({ queryKey: ['projects'] });
    await queryClient.resetQueries({ queryKey: ['project', '0000000002'] });
  });
  await expect(
    page.getByRole('region', { name: 'Unavailable project', exact: true }),
  ).toBeVisible();
  await expect(recovered).toHaveValue(dirtyText);
  await page.evaluate(async () => {
    window.nativeMissing.project = false;
    window.nativeMissing.sessions = false;
    const path = '/src/lib/queries/client.ts';
    const { queryClient } = await import(
      performance
        .getEntriesByType('resource')
        .find((entry) => new URL(entry.name).pathname === path)?.name ?? path
    );
    await queryClient.resetQueries({ queryKey: ['sessions'] });
  });
  await page.getByRole('button', { name: 'Retry project', exact: true }).click();
  await expect(recovered).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.nativeMissing.mutations), 0);
  console.log(
    'Native missing-file/project recovery retains downloadable text, honours discard cancellation, and restores editing on retry.',
  );
}
