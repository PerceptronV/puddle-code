import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* global window, innerWidth, localStorage -- evaluated by Playwright inside the isolated browser */

// Isolated rendered acceptance; no daemon, provider, worktree or installed service.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const { build } = await import(pathToFileURL(join(root, 'node_modules/esbuild/lib/main.js')));
const { chromium, expect } = await import(
  pathToFileURL(join(root, 'packages/web/node_modules/@playwright/test/index.mjs'))
);
const scratch = await mkdtemp(join(tmpdir(), 'puddle-release-notes-ui-'));
const markdown = `# Changelog
## 0.4.0
### Cockpit
**Browser changes** with \`inline code\`.
<script>window.notesUnsafe = true</script>

<img src="/unexpected-image" onerror="window.notesUnsafe = true">

[External documentation](https://example.com/docs)
[Local file](./private.txt)

### Daemon
Host changes.
### Runtime
Owner changes.
### Remote
Remote changes.
`;
let browser;
let server;
try {
  await build({
    stdin: {
      contents: `import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { ReleaseNotesHost } from './src/features/release-notes/ReleaseNotesHost';
        import { HostReleaseNotes } from './src/features/release-notes/HostReleaseNotes';
        import { reportInstalledReleaseNotes } from './src/features/release-notes/state/queue';
        import { tokenStore } from './src/lib/transport/auth';
        import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './src/components/ui/dialog';
        tokenStore.set('isolated-release-notes-fixture');
        const client = new QueryClient();
        window.releaseFixture = {
          report: reportInstalledReleaseNotes,
          refresh: () => client.invalidateQueries({queryKey:['release-notes']}),
        };
        function Fixture() {
          const [settings, setSettings] = React.useState(false);
          return (
          <QueryClientProvider client={client}>
            <main>Project overview<button onClick={() => setSettings(true)}>Open settings</button></main>
            <Dialog open={settings} onOpenChange={setSettings}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Fixture settings</DialogTitle>
                  <DialogDescription>Keep this dialog usable while release notes arrive.</DialogDescription>
                </DialogHeader>
                <input aria-label="Setting value" />
              </DialogContent>
            </Dialog>
            <ReleaseNotesHost remote={location.search.includes('remote')} />
            <HostReleaseNotes hostKey="stable-fixture-host" />
          </QueryClientProvider>
          );
        }
        createRoot(document.getElementById('root')).render(<Fixture />);`,
      resolveDir: join(root, 'packages/web'),
      loader: 'tsx',
    },
    bundle: true,
    format: 'esm',
    splitting: true,
    outdir: scratch,
    entryNames: 'app',
    chunkNames: 'chunks/[name]-[hash]',
    jsx: 'automatic',
    alias: { '@puddle/shared': join(root, 'packages/shared/src/index.ts') },
    define: {
      'process.env.NODE_ENV': '"production"',
      __PUDDLE_RELEASE_VERSION__: '"0.4.0"',
      __PUDDLE_RELEASE_NOTES__: JSON.stringify(markdown),
    },
  });
  const javascript = new Map([
    ['/app.js', await readFile(join(scratch, 'app.js'))],
    ...(await Promise.all(
      (await readdir(join(scratch, 'chunks'))).map(async (name) => [
        `/chunks/${name}`,
        await readFile(join(scratch, 'chunks', name)),
      ]),
    )),
  ]);
  const assets = join(root, 'packages/web/dist/assets');
  const cssName = (await readdir(assets)).find((name) => /^index-.*\.css$/.test(name));
  assert.ok(cssName, 'Build web assets before running browser acceptance');
  const css = await readFile(join(assets, cssName));
  const requests = [];
  server = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    if (javascript.has(req.url)) {
      res.setHeader('content-type', 'text/javascript');
      return res.end(javascript.get(req.url));
    }
    if (req.url === '/app.css') {
      res.setHeader('content-type', 'text/css');
      return res.end(css);
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      '<html data-theme="dark"><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
    );
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1024, height: 820 } });
  let releasePreview;
  let previewRequested;
  let previewRequests = 0;
  const previewPending = new Promise((resolve) => {
    previewRequested = resolve;
  });
  const previewReady = new Promise((resolve) => {
    releasePreview = resolve;
  });
  await context.route('**/chunks/ReleaseNotesDialog-*.js', async (route) => {
    previewRequests++;
    previewRequested();
    await previewReady;
    await route.continue();
  });
  const releases = ['daemon', 'runtime'].map((component) => ({
    component,
    version: '0.4.0',
    markdown,
  }));
  let admit;
  const delayed = new Promise((resolve) => {
    admit = resolve;
  });
  await context.route('**/api/release-notes', async (route) => {
    await delayed;
    await route.fulfill({ json: { releases } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  const dialog = page.getByRole('dialog');
  await previewPending;
  await expect(dialog).toHaveCount(0);
  assert.equal(
    await page.evaluate(
      () =>
        Object.keys(localStorage).filter((key) => key.startsWith('puddle.release-notes.')).length,
    ),
    0,
  );
  releasePreview();
  await expect(dialog).toHaveCount(1);
  await expect(dialog.getByRole('heading', { name: 'Cockpit', exact: true })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Daemon', exact: true })).toHaveCount(0);
  admit();
  await expect(dialog.getByRole('heading', { name: 'Runtime', exact: true })).toBeVisible();
  await expect(dialog).toHaveCount(1);
  await expect(dialog.getByRole('heading', { name: 'Daemon', exact: true })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Remote', exact: true })).toHaveCount(0);
  await expect(dialog.locator('strong')).toHaveText('Browser changes');
  await expect(dialog.locator('img,script,textarea,[contenteditable="true"]')).toHaveCount(0);
  const external = dialog.getByRole('link', { name: 'External documentation' });
  await expect(external).toHaveAttribute('target', '_blank');
  await expect(external).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(dialog.getByText('Local file', { exact: true })).not.toHaveAttribute('href');
  assert.equal(await page.evaluate(() => window.notesUnsafe), undefined);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const loadedPreviews = previewRequests;
  await page.reload();
  await page.evaluate(() => window.releaseFixture.refresh());
  await expect(dialog).toHaveCount(0);
  assert.equal(previewRequests, loadedPreviews, 'Seen notes must not load the preview chunk');

  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Fixture settings', exact: true });
  await expect(settings.getByRole('textbox')).toBeFocused();
  await page.evaluate(
    ({ markdown }) => {
      window.releaseFixture.report('stable-fixture-host', {
        releases: [{ component: 'runtime', version: '0.4.1', markdown }],
      });
      window.releaseFixture.report('stable-fixture-host', {
        releases: [{ component: 'daemon', version: '0.4.2', markdown }],
      });
    },
    { markdown },
  );
  // Pending notes preserve the active dialog and appear after its ordinary close.
  await expect(settings.getByRole('textbox')).toBeFocused();
  await expect(page.locator('[data-release-notes]')).toHaveCount(0);
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(1);
  await expect(dialog.getByRole('heading', { name: 'What’s new in 0.4.1' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Runtime', exact: true })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Daemon', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'What’s new in 0.4.2' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.evaluate(
    ({ releases }) => window.releaseFixture.report('another-stable-host', { releases }),
    { releases },
  );
  await expect(dialog.getByRole('heading', { name: 'What’s new in 0.4.0' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Cockpit', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  // A new mobile/remote browser gets the Remote section before selecting any project.
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
  });
  await mobile.route('**/api/release-notes', (route) => route.fulfill({ json: { releases: [] } }));
  const phone = await mobile.newPage();
  await phone.goto(origin + '/?remote');
  await expect(phone.getByRole('dialog')).toHaveCount(1);
  await expect(phone.getByRole('heading', { name: 'Remote', exact: true })).toBeVisible();
  await expect(phone.getByRole('heading', { name: 'Cockpit', exact: true })).toBeVisible();
  assert.ok(
    await phone
      .getByRole('dialog')
      .evaluate((element) => element.getBoundingClientRect().width <= innerWidth),
  );
  assert.deepEqual(errors, []);
  assert.ok(requests.every((request) => request.method === 'GET'));
  assert.ok(
    !requests.some((request) =>
      /unexpected-image|private\.txt|worktree|\/files/.test(request.path),
    ),
  );
  console.log(
    'Release notes browser acceptance passed: delayed merge, dialog deferral, persistent deduplication, serial versions, target scoping, Markdown safety and mobile overview.',
  );
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
