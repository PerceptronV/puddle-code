import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';

let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: fileURLToPath(new URL('../vite.build.config.ts', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture server port');
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => server?.close());

for (const name of ['Finder', 'File Explorer', 'File Manager']) {
  test(`reveals exact file, folder, tree-root and tab paths through ${name}`, async ({ page }) => {
    const paths: string[] = [];
    const errors: string[] = [];
    let discoveries = 0;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route(`${origin}/cockpit/file-manager`, async (route) => {
      if (route.request().method() === 'GET') {
        discoveries += 1;
        await route.fulfill({ json: { name } });
      } else {
        paths.push(route.request().postDataJSON().path);
        await route.fulfill({ status: 204 });
      }
    });
    await page.goto(`${origin}/e2e/fixtures/file-manager.html`);
    const menu = page.getByRole('menuitem', { name: `Reveal in ${name}`, exact: true });
    for (const path of ['read me.txt', 'src']) {
      await page.locator(`[data-path="${path}"]`).click({ button: 'right' });
      await menu.click();
    }
    await page.getByRole('tree').click({ button: 'right', position: { x: 30, y: 180 } });
    await menu.click();
    for (const tab of ['Worktree file tab', 'External file tab']) {
      await page.getByRole('button', { name: tab }).click({ button: 'right' });
      await menu.click();
    }
    await expect
      .poll(() => paths)
      .toEqual([
        '/work/project/read me.txt',
        '/work/project/src',
        '/work/project',
        '/work/project/read me.txt',
        '/outside/library/notes.txt',
      ]);
    expect(discoveries).toBe(1);
    expect(errors).toEqual([]);
  });
}

test('uses the current browse root and reports native failures', async ({ page }) => {
  const paths: string[] = [];
  await page.route(`${origin}/cockpit/file-manager`, async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { name: 'Finder' } });
    paths.push(route.request().postDataJSON().path);
    return route.fulfill({
      status: 400,
      json: { error: { code: 'reveal_failed', message: 'File no longer exists' } },
    });
  });
  await page.goto(`${origin}/e2e/fixtures/file-manager.html?browse`);
  await page.locator('[data-path="read me.txt"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Reveal in Finder', exact: true }).click();
  await expect(page.getByText('File no longer exists')).toBeVisible();
  expect(paths).toEqual(['/outside/library/read me.txt']);
});

for (const unavailable of ['ssh', 'older', 'remote']) {
  test(`omits native reveal for ${unavailable} connections`, async ({ page }) => {
    let requests = 0;
    await page.route(`${origin}/cockpit/file-manager`, async (route) => {
      requests += 1;
      return route.fulfill({ status: unavailable === 'older' ? 404 : 200, json: { name: null } });
    });
    await page.goto(`${origin}/e2e/fixtures/file-manager.html?${unavailable}`);
    const response =
      unavailable === 'remote' ? null : page.waitForResponse('**/cockpit/file-manager');
    await page.getByRole('button', { name: 'External file tab' }).click({ button: 'right' });
    await response;
    await expect(
      page.getByRole('menuitem', { name: 'Reveal in Filetree', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('menuitem', { name: /^Reveal in (Finder|File Explorer|File Manager)$/ }),
    ).toHaveCount(0);
    expect(requests).toBe(unavailable === 'remote' ? 0 : 1);
  });
}
