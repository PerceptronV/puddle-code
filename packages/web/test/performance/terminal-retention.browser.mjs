/* global window */
// Synthetic parked-view measurements. Optional results stay at the caller's local path.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {
    resolveDir: fileURLToPath(new URL('../../', import.meta.url)),
    contents: `
      import { Terminal } from '@xterm/xterm';
      import { captureParkedTerminal, restoreParkedTerminal } from './src/features/terminal/parked/snapshot';
      let views = [];
      const content = Array.from({ length: 20000 }, (_, row) => 'synthetic row ' + row + ' ' + 'x'.repeat(40)).join('\\r\\n');
      const write = (terminal, text) => new Promise(resolve => terminal.write(text, resolve));
      const create = () => {
        const container = document.createElement('div');
        document.getElementById('parking').appendChild(container);
        const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 20000, allowProposedApi: true });
        terminal.open(container);
        return { terminal, container };
      };
      const signature = terminal => {
        const buffer = terminal.buffer.active;
        let hash = 2166136261;
        for (let row = 0; row < buffer.length; row++) {
          const line = buffer.getLine(row).translateToString();
          for (let i = 0; i < line.length; i++) hash = Math.imul(hash ^ line.charCodeAt(i), 16777619);
        }
        return [hash >>> 0, buffer.length, buffer.baseY, buffer.cursorX, buffer.cursorY, buffer.viewportY];
      };
      Object.assign(window, {
        async addViews(count) {
          while (views.length < count) {
            const view = create();
            await write(view.terminal, content);
            view.terminal.scrollToLine(500);
            views.push(view);
          }
          return { views: views.length, lines: views.reduce((n, view) => n + view.terminal.buffer.normal.length, 0) };
        },
        parkViews() {
          const started = performance.now();
          views = views.map((view, index) => {
            if (index >= views.length - 3) return view;
            const snapshot = captureParkedTerminal(view.terminal);
            if (!snapshot) throw new Error('Synthetic snapshot unexpectedly rejected');
            const saved = { snapshot, signature: signature(view.terminal), container: view.container };
            view.terminal.dispose();
            return saved;
          });
          return { captureMs: performance.now() - started, snapshotBytes: views.reduce((n, view) => n + (view.snapshot?.data.length ?? 0), 0), warmViews: views.filter(view => view.terminal).length };
        },
        async restoreOne() {
          const saved = views[0];
          const started = performance.now();
          const view = create();
          await restoreParkedTerminal(view.terminal, saved.snapshot);
          const actual = signature(view.terminal);
          view.terminal.dispose();
          view.container.remove();
          return { replayMs: performance.now() - started, expected: saved.signature, actual };
        },
        clearViews() { for (const view of views) { view.terminal?.dispose(); view.container.remove(); } views = []; }
      });
    `,
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
});
const browser = await chromium.launch();
const results = [];
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<div id="parking" style="display:none"></div>');
  await page.addStyleTag({
    content: readFileSync(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8'),
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const cdp = await page.context().newCDPSession(page);
  const sample = async (phase, details = {}) => {
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage');
    const dom = await cdp.send('Memory.getDOMCounters');
    const result = { phase, ...details, heap, dom };
    results.push(result);
    console.log(JSON.stringify(result));
  };
  await sample('empty');
  for (const count of [1, 10, 50])
    await sample('warm', await page.evaluate((count) => window.addViews(count), count));
  await sample('serialised', await page.evaluate(() => window.parkViews()));
  const replay = await page.evaluate(() => window.restoreOne());
  assert.deepEqual(replay.actual, replay.expected);
  await sample('replay-verified', { replayMs: replay.replayMs });
  await page.evaluate(() => window.clearViews());
  await sample('closed');
  assert.deepEqual(errors, []);
  if (process.env.PUDDLE_PROFILE_OUTPUT)
    writeFileSync(process.env.PUDDLE_PROFILE_OUTPUT, JSON.stringify(results, null, 2) + '\n');
} finally {
  await browser.close();
}
