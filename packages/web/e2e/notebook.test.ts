import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';

test.use({ viewport: { width: 1000, height: 800 } });
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

test('edits and saves notebook cells, preserves metadata, sanitises output and hides eager runs', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error.stack);
  });
  const notebook = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3' } },
    cells: [
      {
        cell_type: 'markdown',
        metadata: {},
        source: ['# Notebook example\n\nSaved results and editable cells. $x^2$'],
      },
      {
        cell_type: 'code',
        id: 'first',
        metadata: { tags: ['keep'] },
        source: ['print(1)'],
        execution_count: 1,
        outputs: [
          {
            output_type: 'display_data',
            data: {
              'text/html':
                '<table><tr><td>Saved result</td></tr></table><script>window.compromised=true</script><img src="invalid:" onerror="window.compromised=true"><div style="position:fixed;inset:0">Safe text</div>',
            },
            metadata: {},
          },
        ],
      },
    ],
  };
  let saved: { content: string; expected_mtime_ms: number } | null = null;
  await page.route(`${origin}/api/worktrees/**/file?*`, (route) => {
    if (route.request().method() === 'PUT') {
      saved = route.request().postDataJSON();
      return route.fulfill({ json: { mtime_ms: 2 } });
    }
    return route.fulfill({
      json: {
        content: saved?.content ?? JSON.stringify(notebook),
        binary: false,
        mtime_ms: saved ? 2 : 1,
      },
    });
  });
  const kernelActions: string[] = [];
  let releaseSelection: (() => void) | null = null;
  let delaySelection = false;
  let state = 'idle';
  let kernel = 'python3';
  await page.route(`${origin}/api/version`, (route) =>
    route.fulfill({ json: { protocol: { major: 24, minor: 6 } } }),
  );
  await page.route(`${origin}/api/notebooks/kernels`, (route) =>
    route.fulfill({
      json: {
        available: true,
        kernels: [
          { name: 'python3', display_name: 'Python 3', language: 'python' },
          { name: 'alternate', display_name: 'Alternate Python', language: 'python' },
        ],
      },
    }),
  );
  await page.route(`${origin}/api/notebooks/status`, (route) =>
    route.fulfill({ json: { state, kernel } }),
  );
  await page.route(`${origin}/api/notebooks/kernel`, async (route) => {
    const request = route.request().postDataJSON();
    kernelActions.push(request.action);
    if (delaySelection && request.action === 'select')
      await new Promise<void>((resolve) => {
        releaseSelection = resolve;
      });
    if (request.action === 'select') kernel = request.kernel;
    state = request.action === 'shutdown' ? 'stopped' : 'idle';
    return route.fulfill({ json: { state, kernel } });
  });
  await page.goto(`${origin}/e2e/fixtures/notebook.html`);
  await expect(page.getByRole('heading', { name: 'Notebook example' })).toBeVisible();
  await expect(page.getByText('Saved result', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => 'compromised' in window)).toBe(false);
  await expect(page.locator('[style*="position:fixed"]')).toHaveCount(0);
  await expect(page.getByRole('toolbar', { name: 'Notebook', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Outline', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Notebook outline' })).toContainText(
    'Notebook example',
  );
  await page
    .getByRole('navigation', { name: 'Notebook outline' })
    .getByRole('button')
    .first()
    .click();
  await page.getByRole('button', { name: 'Clear All Outputs', exact: true }).click();
  await expect(page.getByText('Saved result', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Clear All Outputs', exact: true })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Select kernel' }).click();
  await page.getByRole('option', { name: 'Alternate Python' }).click();
  await expect.poll(() => kernelActions).toContain('select');
  await page.getByRole('button', { name: 'Kernel actions' }).click();
  await page.getByRole('menuitem', { name: 'Restart kernel' }).click();
  await expect.poll(() => kernelActions).toContain('restart');
  state = 'busy';
  await expect(page.getByRole('button', { name: 'Interrupt', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Interrupt', exact: true }).click();
  await expect.poll(() => kernelActions).toContain('interrupt');
  await page.getByRole('button', { name: 'Kernel actions' }).click();
  await page.getByRole('menuitem', { name: 'Shut down kernel' }).click();
  await expect.poll(() => kernelActions).toContain('shutdown');
  await page.getByRole('combobox', { name: 'Select kernel' }).click();
  await page.getByRole('option', { name: /^Python 3/ }).click();
  await expect.poll(() => kernel).toBe('python3');
  let runs = 0;
  await page.exposeFunction('notebookRunCalled', () => {
    runs++;
  });
  await page.evaluate(() =>
    window.addEventListener('notebook-run', () => {
      void (window as unknown as { notebookRunCalled(): Promise<void> }).notebookRunCalled();
    }),
  );
  await page.getByRole('button', { name: 'Run All', exact: true }).click();
  await expect.poll(() => runs).toBe(1);
  await page.getByText('analysis.ipynb', { exact: true }).first().hover();
  await expect(page.getByRole('button', { name: 'Run file', exact: true })).toBeVisible();
  // The TeX tab still supports eager compilation, but the notebook never does.
  await expect(
    page.getByRole('button', {
      name: 'Enable eager compilation',
      includeHidden: true,
      exact: true,
    }),
  ).toHaveCount(1);
  await page.getByRole('textbox', { name: 'Cell 2 source' }).fill('print(42)\nprint("done")');
  await expect(page.getByText('Saved result', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save notebook', exact: true }).click();
  await expect.poll(() => saved?.content).toBeTruthy();
  const result = JSON.parse(saved!.content);
  expect(result.cells[1]).toMatchObject({
    id: 'first',
    metadata: { tags: ['keep'] },
    source: ['print(42)\n', 'print("done")'],
    outputs: [],
    execution_count: null,
  });
  expect(result.metadata.kernelspec).toMatchObject({
    name: 'python3',
    display_name: 'Python 3',
    language: 'python',
  });
  expect(saved!.expected_mtime_ms).toBe(1);
  await page.getByText('analysis.ipynb', { exact: true }).first().hover();
  await page.getByRole('button', { name: 'Show JSON source', exact: true }).click();
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await page.getByText('analysis.ipynb', { exact: true }).first().hover();
  await page.getByRole('button', { name: 'Show notebook', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Cell 2 source' })).toHaveValue(
    'print(42)\nprint("done")',
  );
  await page.getByRole('button', { name: 'Add code cell', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Cell 3 source' })).toBeVisible();
  // A slow kernel start must not replace edits made while its response is pending.
  delaySelection = true;
  await page.getByRole('combobox', { name: 'Select kernel' }).click();
  await page.getByRole('option', { name: 'Alternate Python' }).click();
  await expect.poll(() => releaseSelection !== null).toBe(true);
  await page.getByRole('textbox', { name: 'Cell 3 source' }).fill('print("keep this edit")');
  releaseSelection!();
  await expect(page.getByRole('combobox', { name: 'Select kernel' })).toContainText(
    'Alternate Python',
  );
  await expect(page.getByRole('textbox', { name: 'Cell 3 source' })).toHaveValue(
    'print("keep this edit")',
  );
  await page.screenshot({ path: '/tmp/puddle-notebook-preview.png' });
  expect(errors).toEqual([]);
});
