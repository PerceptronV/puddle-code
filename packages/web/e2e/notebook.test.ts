import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';

async function editCell(page: Page, index: number, value: string) {
  await page.locator(`[data-notebook-cell="${index - 1}"] .monaco-editor`).click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(value);
}

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

test('offers incomplete Python environments, explicit installation and custom paths', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const local = {
    python: '/project/.venv/bin/python',
    label: '.venv (python)',
    ipykernel: false,
    nbconvert: false,
  };
  let environment: typeof local | undefined;
  let state = 'stopped';
  let failInstall = true;
  const actions: { action: string; python?: string }[] = [];
  await page.route(`${origin}/api/worktrees/**/file?*`, (route) =>
    route.fulfill({
      json: {
        content: JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }),
        binary: false,
        mtime_ms: 1,
      },
    }),
  );
  await page.route(`${origin}/api/version`, (route) =>
    route.fulfill({ json: { protocol: { major: 25, minor: 1 } } }),
  );
  await page.route(`${origin}/api/notebooks/kernels`, (route) =>
    route.fulfill({ json: { available: false, kernels: [] } }),
  );
  await page.route(`${origin}/api/notebooks/environments`, (route) =>
    route.fulfill({ json: { environments: [local] } }),
  );
  await page.route(`${origin}/api/notebooks/status`, (route) =>
    route.fulfill({ json: { state, kernel: environment ? 'python3' : null, environment } }),
  );
  await page.route(`${origin}/api/notebooks/kernel`, (route) => {
    const request = route.request().postDataJSON();
    actions.push(request);
    if (request.action === 'select-python') {
      environment =
        request.python === local.python
          ? local
          : {
              ...local,
              python: '/custom env/bin/python',
              label: 'custom env (python)',
              ipykernel: true,
              nbconvert: true,
            };
      state = environment.ipykernel ? 'idle' : 'stopped';
    }
    if (request.action === 'install-python') {
      if (failInstall)
        return route.fulfill({
          status: 422,
          json: { error: { code: 'install_failed', message: 'No module named pip' } },
        });
      environment = { ...environment!, ipykernel: true, nbconvert: true };
      state = 'idle';
    }
    return route.fulfill({ json: { state, kernel: 'python3', environment } });
  });
  await page.goto(`${origin}/e2e/fixtures/notebook.html`);
  await page.getByRole('button', { name: 'Select Python environment' }).click();
  await expect(page.getByText('ipykernel not installed', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /\.venv \(python\)/ }).click();
  await expect(
    page.getByRole('button', { name: 'Install ipykernel and nbconvert', exact: true }),
  ).toBeVisible();
  expect(actions.map((action) => action.action)).toEqual(['select-python']);
  await page.getByRole('button', { name: 'Install ipykernel and nbconvert', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('No module named pip');
  expect(actions.at(-1)).toMatchObject({ action: 'install-python', python: local.python });
  failInstall = false;
  await page.getByRole('button', { name: 'Install ipykernel and nbconvert', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Install ipykernel and nbconvert', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText('Idle', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Select Python environment' }).click();
  await page
    .getByRole('textbox', { name: 'Environment folder or Python executable' })
    .fill('/custom env');
  await page.getByRole('button', { name: 'Use path', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select Python environment' })).toContainText(
    'custom env',
  );
  expect(actions.at(-1)).toMatchObject({ action: 'select-python', python: '/custom env' });
  await page.screenshot({ path: '/tmp/puddle-notebook-environment.png' });
  expect(errors).toEqual([]);
});

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
  await page.getByRole('heading', { name: 'Notebook example' }).dblclick();
  await editCell(page, 1, '# Edited notebook');
  await page
    .getByRole('textbox', { name: 'Cell 1 source', exact: true })
    .press('ControlOrMeta+Enter');
  await expect(page.getByRole('heading', { name: 'Edited notebook' })).toBeVisible();
  await editCell(page, 2, 'print(2)');
  await expect(page.getByText('Saved result', { exact: true })).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Notebook', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Outline', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Notebook outline' })).toContainText(
    'Edited notebook',
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
  await editCell(page, 2, 'print(42)\nprint("done")');
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
  await expect(page.locator('[data-notebook-cell="1"] .view-lines')).toContainText('print(42)');
  await page.getByRole('button', { name: 'Add code cell', exact: true }).click();
  await expect(page.locator('[data-notebook-cell="2"] .monaco-editor')).toBeVisible();
  // A slow kernel start must not replace edits made while its response is pending.
  delaySelection = true;
  await page.getByRole('combobox', { name: 'Select kernel' }).click();
  await page.getByRole('option', { name: 'Alternate Python' }).click();
  await expect.poll(() => releaseSelection !== null).toBe(true);
  await editCell(page, 3, 'print("keep this edit")');
  releaseSelection!();
  await expect(page.getByRole('combobox', { name: 'Select kernel' })).toContainText(
    'Alternate Python',
  );
  await expect(page.locator('[data-notebook-cell="2"] .view-lines')).toContainText(
    'keep this edit',
  );
  await page.keyboard.press('ControlOrMeta+f');
  await page.getByRole('textbox', { name: 'Find', exact: true }).fill('keep this edit');
  await expect(page.getByRole('search')).toContainText('1 of 1');
  await page.getByRole('textbox', { name: 'Replace in notebook', exact: true }).fill('replacement');
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(page.locator('[data-notebook-cell="2"] .view-lines')).toContainText('replacement');
  await page.getByRole('button', { name: 'Close find', exact: true }).click();
  await page.getByRole('button', { name: 'Fold section', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Cell 2', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand section', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Cell 2', exact: true })).toBeVisible();
  const third = page.getByRole('region', { name: 'Cell 3', exact: true });
  await third.getByRole('button', { name: 'Cell language: python', exact: true }).click();
  await page.getByRole('option', { name: 'markdown', exact: true }).click();
  await expect(
    third.getByRole('button', { name: 'Cell language: markdown', exact: true }),
  ).toBeVisible();
  await third.getByRole('button', { name: 'Cell language: markdown', exact: true }).click();
  await page.getByRole('option', { name: 'python', exact: true }).click();
  await third.hover();
  await third.getByRole('button', { name: 'Duplicate cell', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Cell 4', exact: true })).toBeVisible();
  await page.getByRole('region', { name: 'Cell 4', exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByRole('region', { name: 'Cell 4', exact: true })).toHaveCount(0);
  await page.getByRole('region', { name: 'Cell 2', exact: true }).focus();
  await page.keyboard.press('Shift+ArrowDown');
  await expect(third).toHaveClass(/bg-surface/);
  // Exercise the native clipboard handlers without depending on the OS clipboard.
  await third.evaluate((cell) => {
    const clipboardData = new DataTransfer();
    cell.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, clipboardData }));
    cell.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData }));
  });
  await expect(page.getByRole('region', { name: 'Cell 5', exact: true })).toBeVisible();
  expect(
    await page
      .locator('[data-cell-id]')
      .evaluateAll((cells) => new Set(cells.map((cell) => cell.getAttribute('data-cell-id'))).size),
  ).toBe(5);
  await third.focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByRole('region', { name: 'Cell 4', exact: true })).toHaveCount(0);
  await page.screenshot({ path: '/tmp/puddle-notebook-preview.png' });
  expect(errors).toEqual([]);
});

test('runs exact cell ranges and merges live output without replacing newer edits', async ({
  page,
}) => {
  const notebook = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        id: 'setup',
        cell_type: 'code',
        metadata: {},
        source: 'value = 41',
        execution_count: null,
        outputs: [],
      },
      {
        id: 'answer',
        cell_type: 'code',
        metadata: {},
        source: 'print(value + 1)',
        execution_count: null,
        outputs: [],
      },
    ],
  };
  const requests: { cells: { id: string; source: string }[] }[] = [];
  let execution: import('@puddle/shared').NotebookExecution | null = null;
  await page.route(`${origin}/api/worktrees/**/file?*`, (route) =>
    route.fulfill({ json: { content: JSON.stringify(notebook), binary: false, mtime_ms: 1 } }),
  );
  await page.route(`${origin}/api/version`, (route) =>
    route.fulfill({ json: { protocol: { major: 25, minor: 2 } } }),
  );
  await page.route(`${origin}/api/notebooks/kernels`, (route) =>
    route.fulfill({ json: { available: true, kernels: [] } }),
  );
  await page.route(`${origin}/api/notebooks/status`, (route) =>
    route.fulfill({ json: { state: 'idle', kernel: 'python3' } }),
  );
  await page.route(`${origin}/api/notebooks/execution`, (route) =>
    route.fulfill({ json: { execution } }),
  );
  await page.route(`${origin}/api/notebooks/execute`, (route) => {
    const request = route.request().postDataJSON();
    requests.push(request);
    execution = {
      id: crypto.randomUUID(),
      revision: 1,
      state: 'running',
      cells: request.cells.map((cell: { id: string; source: string }) => ({
        ...cell,
        revision: 1,
        state: 'running',
        outputs: [],
        execution_count: 1,
      })),
    };
    return route.fulfill({ json: { execution } });
  });
  await page.goto(`${origin}/e2e/fixtures/notebook.html`);
  const second = page.getByRole('region', { name: 'Cell 2', exact: true });
  await second.hover();
  await second.getByRole('button', { name: 'Run Above', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]!.cells.map((cell) => cell.id)).toEqual(['setup']);
  await editCell(page, 1, 'value = 99');
  execution = {
    ...execution!,
    state: 'succeeded',
    revision: 2,
    cells: execution!.cells.map((cell) => ({
      ...cell,
      state: 'succeeded',
      revision: 2,
      elapsed_ms: 50,
      outputs: [{ output_type: 'stream', text: 'old source result' }],
    })),
  };
  await expect(page.getByText('old source result', { exact: true })).toBeVisible();
  await expect(page.locator('[data-notebook-cell="0"] .view-lines')).toContainText('value = 99');
  await expect(page.getByText('Source changed', { exact: true })).toBeVisible();
  await second.hover();
  await second.getByRole('button', { name: 'Run Cell and Below', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]!.cells.map((cell) => cell.id)).toEqual(['answer']);
  execution = {
    ...execution!,
    state: 'succeeded',
    revision: 2,
    cells: execution!.cells.map((cell) => ({ ...cell, state: 'succeeded', revision: 2 })),
  };
  await expect(page.getByRole('button', { name: 'Run All', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Run All', exact: true }).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2]!.cells).toEqual([
    { id: 'setup', source: 'value = 99' },
    { id: 'answer', source: 'print(value + 1)' },
  ]);
});
