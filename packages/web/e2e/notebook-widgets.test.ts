import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotebookKernels } from '../../daemon/src/notebooks/kernels.js';
import type { SessionStore } from '../../daemon/src/db/stores/sessions.js';
import type { RepoStore } from '../../daemon/src/db/stores/repos.js';
import { NO_SESSION } from '../../daemon/src/http/routes/worktree-shared.js';

let server: ViteDevServer;
let origin: string;
test.use({ viewport: { width: 1100, height: 1000 }, actionTimeout: 15000 });
test.beforeAll(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: fileURLToPath(new URL('../vite.build.config.ts', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => server?.close());

test('renders real widgets, sends values and binary uploads, keeps callbacks live and restores saved state', async ({
  page,
}) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-widget-browser-')));
  const source = { session: NO_SESSION, root, path: 'analysis.ipynb' };
  const kernels = new NotebookKernels({ sessions: {} as SessionStore, repos: {} as RepoStore });
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error.stack);
  });
  const code = `import ipywidgets as w
import base64
from traitlets import Unicode, Int
from IPython.display import display
class Counter(w.DOMWidget):
    _model_name = Unicode('CounterModel').tag(sync=True)
    _view_name = Unicode('CounterView').tag(sync=True)
    _model_module = Unicode('puddle-widget-fixture').tag(sync=True)
    _view_module = Unicode('puddle-widget-fixture').tag(sync=True)
    _model_module_version = Unicode('1.0.0').tag(sync=True)
    _view_module_version = Unicode('1.0.0').tag(sync=True)
    value = Int(0).tag(sync=True)
custom = Counter()
def increment_custom(widget, content, buffers):
    widget.value += 1
custom.on_msg(increment_custom)
slider = w.IntSlider(value=3, description='Amount')
mirror = w.IntText(description='Mirror')
link = w.jslink((slider, 'value'), (mirror, 'value'))
button = w.Button(description='Increment')
upload = w.FileUpload(description='Upload')
out = w.Output()
image = w.Image(value=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='), format='png', layout=w.Layout(width='16px', height='16px'))
count = 0
def clicked(button):
    global count
    count += 1
    with out:
        print('clicked', count, 'amount', slider.value)
button.on_click(clicked)
display(w.VBox([slider, mirror, button, upload, image, custom, out]))`;
  let content = JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        id: 'widgets',
        cell_type: 'code',
        metadata: {},
        source: code,
        outputs: [],
        execution_count: null,
      },
    ],
  });
  writeFileSync(join(root, source.path), content);
  let extensionLoads = 0;
  await page.route(
    'https://cdn.jsdelivr.net/npm/puddle-widget-fixture@1.0.0/dist/index.js',
    (route) => {
      extensionLoads++;
      return route.fulfill({
        contentType: 'application/javascript',
        body: `
define(['@jupyter-widgets/base'], function(base) {
  class CounterModel extends base.DOMWidgetModel {}
  class CounterView extends base.DOMWidgetView {
    render() {
      const button = document.createElement('button');
      const update = () => { button.textContent = 'Extension count: ' + this.model.get('value'); };
      button.addEventListener('click', () => this.send({ event: 'increment' }));
      this.listenTo(this.model, 'change:value', update);
      this.el.append(button); update();
    }
  }
  return { CounterModel, CounterView };
});`,
      });
    },
  );
  await page.route(`${origin}/api/worktrees/**/file?*`, (route) => {
    if (route.request().method() === 'PUT') {
      content = route.request().postDataJSON().content;
      return route.fulfill({ json: { mtime_ms: 2 } });
    }
    return route.fulfill({ json: { content, binary: false, mtime_ms: 1 } });
  });
  await page.route(`${origin}/api/version`, (route) =>
    route.fulfill({ json: { protocol: { major: 25, minor: 4 } } }),
  );
  await page.route(`${origin}/api/notebooks/**`, async (route) => {
    const endpoint = new URL(route.request().url()).pathname.slice('/api/notebooks/'.length);
    const body = route.request().postDataJSON() ?? {};
    try {
      const result =
        endpoint === 'kernels'
          ? await kernels.catalogue()
          : endpoint === 'environments'
            ? { environments: [] }
            : endpoint === 'status'
              ? await kernels.status(source)
              : endpoint === 'execution'
                ? await kernels.executionStatus(source)
                : endpoint === 'execute'
                  ? await kernels.executeCells({ ...body, source })
                  : endpoint === 'widgets'
                    ? await kernels.widgetState({ ...body, source })
                    : endpoint === 'widgets/comm'
                      ? await kernels.widgetComm({ ...body, source })
                      : endpoint === 'kernel'
                        ? await kernels.action({ ...body, source })
                        : endpoint === 'intelligence'
                          ? { matches: [], start: body.cursor, end: body.cursor, documentation: '' }
                          : {};
      await route.fulfill(result === undefined ? { status: 204 } : { json: result });
    } catch (error) {
      await route.fulfill({
        status: 422,
        json: { error: { code: 'notebook_failed', message: String(error) } },
      });
    }
  });
  try {
    await page.goto(`${origin}/e2e/fixtures/notebook.html`);
    await page.getByRole('button', { name: 'Run All', exact: true }).click();
    const frame = page.frameLocator('iframe[title="Jupyter widget"]');
    await page.locator('iframe[title="Jupyter widget"]').scrollIntoViewIfNeeded();
    await expect(frame.getByRole('button', { name: 'Increment', exact: true })).toBeVisible({
      timeout: 45000,
    });
    await expect(
      frame.getByRole('button', { name: 'Extension count: 0', exact: true }),
    ).toBeVisible();
    await frame.getByRole('button', { name: 'Extension count: 0', exact: true }).click();
    await expect(
      frame.getByRole('button', { name: 'Extension count: 1', exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        frame.locator('img').evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBe(1);
    await expect(page.locator('iframe[title="Jupyter widget"]')).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-downloads',
    );
    await expect(page.getByRole('button', { name: 'Run All', exact: true })).toBeEnabled();
    const mirror = frame.locator('input[type=number]');
    await mirror.fill('17');
    await mirror.press('Enter');
    await frame.getByRole('button', { name: 'Increment', exact: true }).click();
    await expect(frame.locator('.widget-output')).toContainText('clicked 1 amount 17');
    const choosingFile = page.waitForEvent('filechooser');
    await frame.getByRole('button', { name: /Upload/ }).click();
    await (
      await choosingFile
    ).setFiles({
      name: 'sample.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from([0, 127, 255, 42]),
    });
    await expect(frame.getByRole('button', { name: /Upload/ })).toContainText('(1)');
    await kernels.executeCells({
      source,
      cells: [{ id: 'check', source: 'print(slider.value, list(upload.value[0]["content"]))' }],
    });
    await expect
      .poll(async () =>
        JSON.stringify((await kernels.executionStatus(source)).execution?.cells[0]?.outputs),
      )
      .toContain('17 [0, 127, 255, 42]');
    await page.getByRole('button', { name: 'Save notebook', exact: true }).click();
    await expect
      .poll(
        () => JSON.parse(content).metadata.widgets?.['application/vnd.jupyter.widget-state+json'],
      )
      .toBeTruthy();
    await page.reload();
    await page.locator('iframe[title="Jupyter widget"]').scrollIntoViewIfNeeded();
    await expect(frame.getByRole('button', { name: 'Increment', exact: true })).toBeVisible();
    await expect(mirror).toHaveValue('17');
    await frame.getByRole('button', { name: 'Increment', exact: true }).click();
    await expect(frame.locator('.widget-output')).toContainText('clicked 2 amount 17');
    await page.screenshot({ path: '/tmp/puddle-live-widgets.png' });
    await kernels.action({ source, action: 'shutdown' });
    await expect(page.getByText('Saved widget · run the cell to reconnect')).toBeVisible();
    await expect(mirror).toHaveValue('17');
    expect((await kernels.status(source)).state).toBe('stopped');
    const loadsBeforeSaved = extensionLoads;
    await expect(
      page.getByRole('button', { name: 'Load puddle-widget-fixture widget extension' }),
    ).toBeVisible();
    expect(extensionLoads).toBe(loadsBeforeSaved);
    await page.getByRole('button', { name: 'Load puddle-widget-fixture widget extension' }).click();
    await expect(
      frame.getByRole('button', { name: 'Extension count: 1', exact: true }),
    ).toBeVisible();
    expect((await kernels.status(source)).state).toBe('stopped');
    expect(errors).toEqual([]);
  } finally {
    await kernels.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
