import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import type { CompilationCommandSlot, CompilationProvider } from '@puddle/shared';

test.use({ viewport: { width: 1000, height: 900 } });
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

const providers: CompilationProvider[] = [
  {
    id: 'latex',
    display_name: 'LaTeX',
    extensions: ['tex'],
    input_extensions: ['tex'],
    available: true,
    executor: 'latexmk',
    eager: true,
  },
  {
    id: 'python',
    display_name: 'Python',
    extensions: ['py'],
    input_extensions: ['py'],
    available: true,
    executor: 'python3',
    eager: false,
  },
  {
    id: 'rust',
    display_name: 'Rust',
    extensions: ['rs'],
    input_extensions: ['rs'],
    available: false,
    executor: null,
    eager: false,
  },
];

test('edits language defaults and file overrides through the same controls', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const defaults: Record<string, string | null> = {};
  let fileCommand: string | null = null;
  let failSave = false;
  await page.route(`${origin}/api/version`, (route) =>
    route.fulfill({ json: { protocol: { major: 24, minor: 4 } } }),
  );
  await page.route(`${origin}/api/compilation/capabilities`, (route) =>
    route.fulfill({ json: { providers } }),
  );
  await page.route(`${origin}/api/compilation/{defaults,settings}`, async (route) => {
    const file = route.request().url().endsWith('/settings');
    const body = route.request().postDataJSON();
    if (route.request().method() === 'PUT') {
      if (failSave)
        return route.fulfill({
          status: 400,
          json: {
            error: { code: 'invalid_compilation_command', message: 'Unknown command value' },
          },
        });
      if (file) fileCommand = body.command;
      else defaults[`${body.provider}:${body.mode}`] = body.command;
    }
    const provider = providers.find((entry) => entry.id === body.provider)!;
    const commands: CompilationCommandSlot[] = (
      provider.eager ? (['on_demand', 'eager'] as const) : (['on_demand'] as const)
    ).map((mode) => ({
      mode,
      run_when: mode === 'on_demand' ? 'when_clicked' : 'upon_file_change',
      default_command: provider.executor ? `${provider.executor} {{source}}` : null,
      override_command: file ? fileCommand : (defaults[`${provider.id}:${mode}`] ?? null),
      ...(file ? { inherited_command: defaults[`${provider.id}:${mode}`] ?? null } : {}),
    }));
    await route.fulfill({
      json: {
        provider: provider.id,
        display_name: provider.display_name,
        variables: [{ placeholder: '{{source}}', description: 'Source file' }],
        commands,
        ...(file ? { file_path: '/source/script.py', file_type: 'python' } : {}),
      },
    });
  });
  await page.goto(`${origin}/e2e/fixtures/compilation-settings.html`);
  await expect(page.getByRole('textbox', { name: 'Upon file change command' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Language' }).click();
  await page.getByRole('option', { name: 'Python', exact: true }).click();
  const command = page.getByRole('textbox', { name: 'When clicked command' });
  await expect(command).toHaveValue('python3 {{source}}');
  await expect(page.getByRole('textbox', { name: 'Upon file change command' })).toHaveCount(0);
  await command.fill('python3 -u {{source}}');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => defaults['python:on_demand']).toBe('python3 -u {{source}}');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

  await page.getByRole('button', { name: 'File settings' }).click();
  const dialog = page.getByRole('dialog');
  const fileField = dialog.getByRole('textbox', { name: 'When clicked command' });
  await expect(fileField).toHaveValue('python3 -u {{source}}');
  await expect(dialog.getByText('Using the language default')).toBeVisible();
  await fileField.fill('python3 -O {{source}}');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(fileCommand).toBe('python3 -O {{source}}');
  // Editing a language leaves an existing file override alone.
  await command.fill('python3 -B {{source}}');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => defaults['python:on_demand']).toBe('python3 -B {{source}}');
  await page.getByRole('button', { name: 'File settings' }).click();
  await expect(fileField).toHaveValue('python3 -O {{source}}');
  await dialog.getByRole('button', { name: 'Use default' }).click();
  await expect(fileField).toHaveValue('python3 -B {{source}}');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(fileCommand).toBeNull();

  failSave = true;
  await command.fill('python3 {{unknown}}');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Unknown command value');
  await expect(command).toHaveValue('python3 {{unknown}}');
  failSave = false;
  await page.getByRole('button', { name: 'Use default' }).click();
  await expect(command).toHaveValue('python3 {{source}}');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => defaults['python:on_demand']).toBeNull();
  await page.getByRole('combobox', { name: 'Language' }).click();
  await page.getByRole('option', { name: 'Rust' }).click();
  await expect(command).toHaveValue('');
  await expect(
    page.getByText('No supported Rust tool is installed on this host.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('combobox', { name: 'Language' }).click();
  await page.getByRole('option', { name: 'LaTeX', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Upon file change command' })).toBeVisible();
  await page.screenshot({ path: '/tmp/puddle-compilation-settings.png' });
  expect(errors).toEqual([]);
});

test('hides language defaults on older daemons', async ({ page }) => {
  let calls = 0;
  await page.route(`${origin}/api/version`, (route) =>
    route.fulfill({ json: { protocol: { major: 24, minor: 3 } } }),
  );
  await page.route(`${origin}/api/compilation/**`, (route) => {
    calls++;
    return route.abort();
  });
  await page.goto(`${origin}/e2e/fixtures/compilation-settings.html`);
  await expect(page.getByRole('heading', { name: 'Editor', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Language' })).toHaveCount(0);
  expect(calls).toBe(0);
});
