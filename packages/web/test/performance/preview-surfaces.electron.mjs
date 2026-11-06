/* global window */
// Isolated Electron fixture: never imports the desktop launcher or starts puddled.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { _electron as electron, expect } from '@playwright/test';

const require = createRequire(import.meta.url);
const desktopRequire = createRequire(new URL('../../../desktop/package.json', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'puddle-synthetic-surfaces-'));
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./preview-surfaces-entry.tsx', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  loader: { '.css': 'empty' },
  plugins: [
    {
      name: 'pdf-assets',
      setup(build) {
        build.onResolve({ filter: /^pdfjs-dist$/ }, () => ({ path: '/pdf.mjs', external: true }));
        build.onResolve({ filter: /pdf\.worker\.min\.mjs\?url$/ }, () => ({
          path: 'worker-url',
          namespace: 'fixture',
        }));
        build.onResolve({ filter: /^virtual:katex-inline-css$/ }, () => ({
          path: 'katex',
          namespace: 'fixture',
        }));
        // The synthetic HTML contains no maths; production's Vite CSS plugin is not needed.
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents:
            args.path === 'katex' ? 'export default ""' : 'export default "/pdf.worker.mjs"',
        }));
      },
    },
  ],
});
const server = createServer((request, response) => {
  const path = request.url;
  if (path === '/bundle.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(bundle.outputFiles[0].text);
  } else if (path === '/pdf.mjs' || path === '/pdf.worker.mjs') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(
      readFileSync(
        require.resolve(
          path === '/pdf.mjs' ? 'pdfjs-dist/build/pdf.mjs' : 'pdfjs-dist/build/pdf.worker.min.mjs',
        ),
      ),
    );
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      '<style>html,body,#root{height:100%;margin:0}.h-full,.size-full{height:100%}.w-full,.size-full{width:100%}.overflow-auto{overflow:auto}.flex{display:flex}.flex-col{flex-direction:column}.items-center{align-items:center}.relative{position:relative}.absolute{position:absolute}.p-4{padding:16px}.gap-4{gap:16px}.shrink-0{flex-shrink:0}iframe{border:0}</style><div id="root"></div><script type="module" src="/bundle.js"></script>',
    );
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const fixture = join(scratch, 'main.cjs');
writeFileSync(
  fixture,
  `const {app,BrowserWindow}=require('electron');
app.setPath('userData', process.env.PUDDLE_FIXTURE_DATA);
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:1000,height:800,show:false,webPreferences:{contextIsolation:true,sandbox:true}});
  await win.loadURL(process.env.PUDDLE_FIXTURE_URL);
  win.showInactive();
});`,
);
let app;
const results = [];
try {
  app = await electron.launch({
    executablePath: desktopRequire('electron'),
    args: [fixture],
    env: {
      ...process.env,
      PUDDLE_FIXTURE_DATA: join(scratch, 'profile'),
      PUDDLE_FIXTURE_URL: `http://127.0.0.1:${server.address().port}`,
    },
  });
  const page = await app.firstWindow();
  const mainId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
  await page.waitForFunction(() => typeof window.show === 'function');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('LayerTree.enable');
  // Playwright enables focus emulation; allow native minimise/occlusion signals.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  let layerCount = 0;
  cdp.on('LayerTree.layerTreeDidChange', (event) => {
    layerCount = event.layers?.length ?? 0;
  });
  if (process.env.PUDDLE_TRACE_OUTPUT)
    await app.evaluate(async ({ contentTracing }) =>
      contentTracing.startRecording({
        included_categories: ['cc', 'gpu', 'viz', 'blink'],
        record_mode: 'record-until-full',
      }),
    );
  const sample = async (phase) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!page.isClosed()) await cdp.send('HeapProfiler.collectGarbage');
    const processes = await app.evaluate(({ app, BrowserWindow }) => ({
      metrics: app.getAppMetrics().map(({ pid, type, memory }) => ({ pid, type, memory })),
      windows: BrowserWindow.getAllWindows().map((win) => ({
        renderer: win.webContents.getOSProcessId(),
        visible: win.isVisible(),
        minimized: win.isMinimized(),
      })),
    }));
    const gpu = processes.metrics.find((process) => process.type === 'GPU');
    let surfaces = null;
    if (gpu && process.platform === 'darwin') {
      const inspection = spawnSync('vmmap', ['-summary', String(gpu.pid)], { encoding: 'utf8' });
      if (inspection.status !== 0) throw new Error('Synthetic GPU inspection failed');
      surfaces = inspection.stdout
        .split('\n')
        .filter((line) => /^IOSurface\s|^Physical footprint:/.test(line.trim()))
        .map((line) => line.trim());
    }
    results.push({
      phase,
      inventory: page.isClosed() ? null : await page.evaluate(() => window.inventory()),
      workers: page.workers().length,
      layerCount,
      heap: page.isClosed() ? null : await cdp.send('Runtime.getHeapUsage'),
      dom: page.isClosed() ? null : await cdp.send('Memory.getDOMCounters'),
      ...processes,
      surfaces,
    });
    if (process.env.PUDDLE_PROFILE_OUTPUT)
      writeFileSync(process.env.PUDDLE_PROFILE_OUTPUT, JSON.stringify(results, null, 2) + '\n');
    console.log(`Measured synthetic phase: ${phase}`);
  };
  await sample('empty');
  for (const kind of ['pdf', 'html']) {
    await page.evaluate((kind) => window.show(kind), kind);
    if (kind === 'pdf')
      await expect
        .poll(() =>
          page
            .locator('canvas')
            .evaluateAll((canvases) => canvases.filter((canvas) => canvas.width > 300).length),
        )
        .toBeGreaterThan(0);
    else await expect(page.locator('iframe')).toHaveCount(1);
    await sample(kind + '-visible');
    await app.evaluate(({ BrowserWindow }, id) => {
      const main = BrowserWindow.fromId(id);
      const cover = new BrowserWindow({ ...main.getBounds(), show: false });
      cover.loadURL('about:blank');
      cover.showInactive();
    }, mainId);
    await sample(kind + '-covered');
    await app.evaluate(
      ({ BrowserWindow }, id) =>
        BrowserWindow.getAllWindows()
          .find((win) => win.id !== id)
          .close(),
      mainId,
    );
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).minimize(), mainId);
    await sample(kind + '-minimized');
    await app.evaluate(({ BrowserWindow }, id) => {
      const win = BrowserWindow.fromId(id);
      win.restore();
      win.showInactive();
    }, mainId);
    for (let i = 0; i < 8; i++) {
      await app.evaluate(
        ({ BrowserWindow }, { id, width }) => BrowserWindow.fromId(id).setSize(width, 800),
        { id: mainId, width: i % 2 ? 1000 : 1200 },
      );
      await page.waitForTimeout(100);
    }
    await sample(kind + '-resized');
    await page.evaluate(() => window.show('none'));
    await expect(page.locator('canvas,iframe')).toHaveCount(0);
    await expect.poll(() => page.workers().length).toBe(0);
    await sample(kind + '-closed');
    await page.waitForTimeout(5000);
    await sample(kind + '-settled');
  }
  await page.evaluate(() => window.show('html'));
  await app.evaluate(async ({ BrowserWindow }, id) => {
    const main = BrowserWindow.fromId(id);
    for (let i = 0; i < 3; i++) {
      const win = new BrowserWindow({
        width: 1000,
        height: 800,
        show: false,
        webPreferences: { contextIsolation: true, sandbox: true },
      });
      await win.loadURL(main.webContents.getURL());
      await win.webContents.executeJavaScript("window.show('html')");
      win.showInactive();
    }
  }, mainId);
  await sample('four-html-windows');
  await app.evaluate(({ BrowserWindow }, id) => {
    for (const win of BrowserWindow.getAllWindows()) if (win.id !== id) win.close();
  }, mainId);
  await page.waitForTimeout(5000);
  await sample('one-html-window-after-close');
  if (process.env.PUDDLE_TRACE_OUTPUT)
    await app.evaluate(
      async ({ contentTracing }, path) => contentTracing.stopRecording(path),
      process.env.PUDDLE_TRACE_OUTPUT,
    );
  let ended = false;
  app.on('close', () => {
    ended = true;
  });
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), mainId);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  if (ended) results.push({ phase: 'all-windows-closed', processEnded: true });
  else await sample('all-windows-closed');
  assert.deepEqual(errors, []);
  if (process.env.PUDDLE_PROFILE_OUTPUT)
    writeFileSync(process.env.PUDDLE_PROFILE_OUTPUT, JSON.stringify(results, null, 2) + '\n');
  console.log(
    JSON.stringify(
      results.map(({ phase, inventory, workers, layerCount, surfaces }) => ({
        phase,
        inventory,
        workers,
        layerCount,
        surfaces,
      })),
    ),
  );
  console.log(
    'Synthetic Electron preview lifecycle complete; no application or daemon was launched.',
  );
} finally {
  await app?.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
}
