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
  await page.goto(`${origin}/e2e/fixtures/notebook.html`);
  await expect(page.getByRole('heading', { name: 'Notebook example' })).toBeVisible();
  await expect(page.getByText('Saved result', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => 'compromised' in window)).toBe(false);
  await expect(page.locator('[style*="position:fixed"]')).toHaveCount(0);
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
  expect(result.metadata).toEqual(notebook.metadata);
  expect(saved!.expected_mtime_ms).toBe(1);
  await page.getByText('analysis.ipynb', { exact: true }).first().hover();
  await page.getByRole('button', { name: 'Show JSON source', exact: true }).click();
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await page.getByText('analysis.ipynb', { exact: true }).first().hover();
  await page.getByRole('button', { name: 'Show notebook', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Cell 2 source' })).toHaveValue(
    'print(42)\nprint("done")',
  );
  await page.getByRole('button', { name: 'Code cell', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Cell 3 source' })).toBeVisible();
  await page.screenshot({ path: '/tmp/puddle-notebook-preview.png' });
  expect(errors).toEqual([]);
});
