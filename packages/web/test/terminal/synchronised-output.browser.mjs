/* global window */
// Synthetic terminal input only. No daemon, cockpit, account or local report data.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./synchronised-output-entry.ts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
});
const css = readFileSync(require.resolve('@xterm/xterm/css/xterm.css'));
const server = createServer((req, res) => {
  if (req.url === '/bundle.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(bundle.outputFiles[0].contents);
  } else if (req.url === '/xterm.css') {
    res.setHeader('Content-Type', 'text/css');
    res.end(css);
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<link rel="stylesheet" href="/xterm.css"><div id="terminal"></div><script src="/bundle.js"></script>',
    );
  }
});
let browser;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  browser = await chromium.launch();
  const pages = await Promise.all([browser.newPage(), browser.newPage()]);
  const errors = [];
  for (const page of pages) page.on('pageerror', (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}`;
  await Promise.all(pages.map((page, i) => page.goto(url + (i ? '?patched' : ''))));
  assert.deepEqual(errors, [], 'Terminal fixtures initialise');
  const both = (fn, arg) => Promise.all(pages.map((page) => page.evaluate(fn, arg)));
  const write = (data) => both((text) => window.write(text), data);
  const equal = async (label) => {
    const states = await both(() => window.snapshot());
    assert.deepEqual(states[1], states[0], label);
  };
  await write(
    Array.from({ length: 24 }, (_, row) => `Synthetic row ${row}`).join('\r\n') + '\x1b[12;3H',
  );
  await both(() => window.settle());
  const before = await both(() => window.renderedRows());
  for (let i = 0; i < 6; i++) {
    await write('\x1b[?2026h\x1b[39m\x1b[49m\x1b[0m\x1b[12;3H\x1b[?25h\x1b[?2026l');
  }
  const after = await both(() => window.renderedRows());
  assert.ok(after[0] - before[0] >= 24 * 6, 'Control refreshes the whole viewport');
  assert.ok(after[1] - before[1] <= 2 * 6, 'Patched refresh is bounded to cursor rows');
  await equal('Cursor-only updates preserve the complete rendered state');

  // Accumulate distant dirty rows across separate writes without painting early.
  const initial = await both(() => window.snapshot().rows);
  await write('\x1b[?2026h\x1b[2;1H\x1b[31mred\x1b[0m');
  await write('\x1b[20;1Hwide: 界 e\u0301\x1b[4m underline\x1b[0m');
  assert.deepEqual(await both(() => window.snapshot().rows), initial);
  await write('\x1b[?2026l');
  await equal('Closing a split update flushes every buffered dirty row');

  for (const sequence of [
    '\x1b[?2026h\x1b[1;1Hnew\x1b[23;20H\x1b[?2026l',
    '\x1b[?2026h\x1b[?25l\x1b[?2026l',
    '\x1b[?2026h\x1b[?25h\x1b[?2026l',
    '\x1b[?2026h\x1b[?1049h\x1b[2Jalternate\x1b[?2026l',
    '\x1b[?2026h\x1b[?1049;2026l',
    '\x1b[?2026h\x1b[24;1H\r\nscroll\r\nmore\x1b[?2026l',
  ]) {
    await write(sequence);
    await equal('Cursor visibility, movement, alternate buffers and scrolling match');
  }
  await both(async () => {
    window.terminal.scrollToTop();
    window.terminal.select(0, 0, 8);
    await window.settle();
  });
  await write('\x1b[?2026h\x1b[24;1Hbelow viewport\x1b[?2026l');
  await equal('A scrolled viewport and selection remain intact');
  await write('\x1b[?2026h\x1b[3;1Hpending resize');
  await both(async () => {
    window.terminal.resize(70, 20);
    window.terminal.options.theme = { foreground: '#abcdef', background: '#123456' };
    await window.settle();
  });
  await write('\x1b[?2026l');
  await equal('Resize and theme invalidations survive the synchronised block');
  await write('\x1b[?2026h\x1b[4;1Htimeout flush');
  await Promise.all(pages.map((page) => page.waitForTimeout(1200)));
  await both(() => window.settle());
  await equal('The native missing-end timeout still flushes output');
  const modes = await both(() => window.terminal.modes.synchronizedOutputMode);
  assert.deepEqual(modes, [false, false]);
  assert.deepEqual(errors, []);
  console.log('Synchronised terminal dirty ranges, rendering equivalence and timeout pass.');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
