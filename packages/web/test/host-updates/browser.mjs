import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

// Manual browser acceptance after pnpm build; no daemon, agent or installed service is started.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const { build } = await import(pathToFileURL(join(root, 'node_modules/esbuild/lib/main.js')));
const { chromium, expect } = await import(
  pathToFileURL(join(root, 'packages/web/node_modules/@playwright/test/index.mjs'))
);
const scratch = await mkdtemp(join(tmpdir(), 'puddle-host-ui-'));
const cssName = (await readdir(join(root, 'packages/web/dist/assets'))).find((file) =>
  /^index-.*\.css$/.test(file),
);
await build({
  stdin: {
    contents: `import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
    import { Toaster } from 'sonner';
    import { HostUpdatesSection } from './src/features/host-updates/HostUpdatesSection';
    import { HostUpdateToast } from './src/features/host-updates/HostUpdateToast';
    import { tokenStore } from './src/lib/transport/auth';
    tokenStore.set('fixture-browser-authority');
    const client = new QueryClient();
    function App() {
      const [open, setOpen] = useState(true);
      return <QueryClientProvider client={client}>
        <button onClick={() => setOpen(!open)}>Toggle settings</button>
        <main className="mx-auto max-w-2xl p-6">{open && <HostUpdatesSection />}</main>
        <HostUpdateToast /><Toaster closeButton />
      </QueryClientProvider>;
    }
    createRoot(document.getElementById('root')).render(<App />);`,
    resolveDir: join(root, 'packages/web'),
    loader: 'tsx',
  },
  bundle: true,
  format: 'esm',
  outfile: join(scratch, 'app.js'),
  jsx: 'automatic',
  alias: { '@puddle/shared': join(root, 'packages/shared/src/index.ts') },
  define: { 'process.env.NODE_ENV': '"production"' },
});
const app = await readFile(join(scratch, 'app.js'));
const css = await readFile(join(root, 'packages/web/dist/assets', cssName));
const fonts = new Map(
  await Promise.all(
    [...css.toString().matchAll(/url\((\/assets\/[^)]+\.woff2)\)/g)].map(async ([, path]) => [
      path,
      await readFile(join(root, 'packages/web/dist', path.slice(1))),
    ]),
  ),
);
const server = createServer((req, res) => {
  if (fonts.has(req.url)) {
    res.setHeader('content-type', 'font/woff2');
    return res.end(fonts.get(req.url));
  }
  if (req.url === '/app.js') {
    res.setHeader('content-type', 'text/javascript');
    return res.end(app);
  }
  if (req.url === '/app.css') {
    res.setHeader('content-type', 'text/css');
    return res.end(css);
  }
  if (req.url === '/api/host') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ hostname: 'fixture-host', displayName: '' }));
  }
  res.setHeader('content-type', 'text/html');
  res.end(
    '<html data-theme="dark"><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
  );
});
let browser;
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1024, height: 920 } });
  const status = {
    availability: 'ready',
    daemon_version: '0.4.0',
    capabilities: { interruption_approval: true, verify_completion: true, continue_recovery: true },
    result: { ok: true, operation: null },
    catalogue: {
      observed_at: Date.now(),
      daemon_version: '0.4.0',
      runtime_default: { version: '0.4.0', protocol: { major: 1, minor: 0 } },
      runtimes: {
        complete: true,
        versions: [
          {
            version: '0.4.0',
            protocol: { major: 1, minor: 0 },
            running: 3,
            starting: 0,
            unavailable: 0,
          },
        ],
      },
      releases: {
        repository: 'example/puddle',
        state: 'ready',
        checked_at: Date.now(),
        succeeded_at: Date.now(),
        latest: { version: '0.4.1', host_asset: true },
      },
    },
  };
  const writes = [];
  let releasePreparation;
  const sockets = [];
  await context.routeWebSocket('**/ws', (ws) => {
    sockets.push(ws);
    ws.onMessage((message) => {
      if (JSON.parse(message).t === 'auth') ws.send(JSON.stringify({ t: 'authenticated' }));
    });
  });
  await context.route('**/cockpit/updates', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: status });
    const input = request.postDataJSON();
    writes.push(input);
    if (input.action === 'prepare') {
      status.result = {
        ok: true,
        operation: {
          id: '11111111-1111-4111-8111-111111111111',
          revision: 2,
          created_at: Date.now(),
          updated_at: Date.now(),
          phase: 'downloading',
          targets: input.targets,
          staged: false,
          dispatched: false,
          message: null,
        },
      };
      await new Promise((resolve) => {
        releasePreparation = resolve;
      });
      status.result.operation.phase = 'staged';
      status.result.operation.staged = true;
    } else if (input.action === 'inspect') {
      status.result.operation.phase = 'preflight';
      status.result.operation.revision++;
      return route.fulfill({
        json: {
          ...status.result,
          review: {
            fingerprint: null,
            can_apply: false,
            interruption_fingerprint: 'b'.repeat(64),
            blockers: [{ code: 'interruption_approval_required' }],
            more_blockers: 0,
            affected: { terminals: 2, notebooks: 1, compilation: 0, programmes: 0 },
          },
        },
      });
    } else if (input.action === 'apply') {
      status.result.operation.phase = 'applying';
      status.result.operation.revision++;
      status.result.operation.dispatched = true;
      return route.abort('connectionreset');
    } else if (input.action === 'continue-offline') {
      assert.equal(status.availability, 'unavailable');
      assert.equal(input.reference.revision, status.result.operation.revision);
      status.result.operation.phase = 'verifying';
      status.result.operation.revision++;
      status.capabilities.offline_continuation = false;
      return route.abort('connectionreset');
    } else throw new Error(`unexpected action ${input.action}`);
    return route.fulfill({ json: status.result });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await expect(
    page.getByText('fixture-host: Daemon 0.4.1 is available.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('fixture-host: Runtime software 0.4.1 is available.', { exact: true }),
  ).toBeVisible();
  const closes = page.getByRole('button', { name: 'Close toast', exact: true });
  await closes.first().click();
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(1);
  await closes.first().click();
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Prepare daemon 0.4.1', exact: true }).click();
  await expect(page.getByText('Preparing update…', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Toggle settings' }).click();
  await page.getByRole('button', { name: 'Toggle settings' }).click();
  await expect(page.getByRole('button', { name: 'Prepare both', exact: true })).toBeDisabled();
  releasePreparation();
  await expect(page.getByRole('button', { name: 'Review impact', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Review impact', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Interrupt listed work and apply', exact: true }),
  ).toBeVisible();
  if (process.env.PUDDLE_HOST_UPDATE_SCREENSHOT)
    await page.screenshot({ path: process.env.PUDDLE_HOST_UPDATE_SCREENSHOT, fullPage: true });
  await page.getByRole('button', { name: 'Interrupt listed work and apply', exact: true }).click();
  await expect(page.getByText('Applying update', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Interrupt listed work and apply', exact: true }),
  ).toHaveCount(0);
  assert.equal(writes.filter((input) => input.action === 'apply').length, 1);
  assert.equal(writes.at(-1).interruption_approval, 'b'.repeat(64));
  status.availability = 'unavailable';
  status.observation = 'recorded';
  status.capabilities = {
    interruption_approval: false,
    verify_completion: false,
    continue_recovery: false,
  };
  const catalogue = status.catalogue;
  delete status.catalogue;
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(page.getByText('Recorded status: Applying update', { exact: true })).toBeVisible();
  await expect(page.getByText('Last connected version: 0.4.0', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Verify completion', exact: true })).toHaveCount(0);
  status.result.operation.phase = 'recovery_required';
  status.capabilities.offline_continuation = true;
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Continue recovery on host', exact: true }),
  ).toBeEnabled();
  if (process.env.PUDDLE_HOST_UPDATE_OFFLINE_SCREENSHOT)
    await page.screenshot({
      path: process.env.PUDDLE_HOST_UPDATE_OFFLINE_SCREENSHOT,
      fullPage: true,
    });
  await page.getByRole('button', { name: 'Continue recovery on host', exact: true }).click();
  await expect(page.getByText('Recorded status: Verifying update', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Continue recovery on host', exact: true }),
  ).toHaveCount(0);
  assert.equal(writes.filter((input) => input.action === 'continue-offline').length, 1);
  status.result.operation.phase = 'complete';
  status.result.operation.revision++;
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(page.getByText('Recorded status: Update complete', { exact: true })).toBeVisible();
  await expect(page.getByText('Update complete', { exact: true })).toHaveCount(0);
  await expect(
    page.getByText(/does not confirm current service health or runtime adoption/),
  ).toBeVisible();
  assert.equal(writes.length, 4);
  status.availability = 'ready';
  status.observation = 'live';
  status.capabilities = {
    interruption_approval: true,
    verify_completion: true,
    continue_recovery: true,
  };
  status.catalogue = catalogue;
  status.catalogue.daemon_version = '0.4.1';
  status.catalogue.runtime_default.version = '0.4.1';
  status.catalogue.releases.latest.version = '0.4.2';
  assert.ok(sockets.length > 0, 'the fixture must have an authenticated status socket');
  for (const socket of sockets) socket.send(JSON.stringify({ t: 'host-updates-changed' }));
  await expect(
    page.getByText('fixture-host: Daemon 0.4.2 is available.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Update complete', { exact: true })).toBeVisible();
  const second = await context.newPage();
  await second.goto(origin);
  await expect(
    second.getByText('fixture-host: Daemon 0.4.2 is available.', { exact: true }),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    'PASS: explicit prepare/review/interruption approval, remount during preparation, recorded offline status and explicit continuation, lost apply/recovery replies without replay, dismissed/repeated/new-release/new-window offers',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
