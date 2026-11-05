/* global window, Blob */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {
    resolveDir: fileURLToPath(new URL('../../', import.meta.url)),
    contents: `
      import { createElement, Profiler } from 'react';
      import { createRoot } from 'react-dom/client';
      import { Terminal } from '@xterm/xterm';
      import { TerminalRichOutput } from './src/features/terminal/rich-output/TerminalRichOutput';
      import { applyTheme } from './src/lib/appearance/theme';
      import { downloadBlob } from './src/lib/download-blob';
      const terminal = new Terminal({ cols: 80, rows: 24, cursorBlink: false, allowProposedApi: true });
      terminal.open(document.getElementById('terminal'));
      window.commits = 0;
      createRoot(document.getElementById('react')).render(createElement(Profiler, {
        id: 'rich-output', onRender: () => window.commits++
      }, createElement(TerminalRichOutput, { terminal })));
      Object.assign(window, { terminal, applyTheme, downloadBlob });
    `,
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  // Measure the real projection component, independent of diagram rendering cost.
  plugins: [
    {
      name: 'block-observer',
      setup(builder) {
        builder.onResolve({ filter: /\/TerminalRichBlock$/ }, () => ({
          path: 'block',
          namespace: 'fixture',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents:
            'export function TerminalRichBlock(props) { window.lastBlock = props; return null; }',
        }));
      },
    },
  ],
});
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://terminal.test/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<div id="terminal"></div><div id="react"></div>',
    }),
  );
  await page.goto('http://terminal.test/');
  await page.addStyleTag({
    content: readFileSync(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8'),
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const write = async (text) => {
    await page.evaluate(
      (value) => new Promise((resolve) => window.terminal.write(value, resolve)),
      text,
    );
    await page.waitForTimeout(250);
  };
  await write('Synthetic text');
  await write('\x1b[10;1Hspinner |');
  const emptyBefore = await page.evaluate(() => window.commits);
  for (const spinner of ['/', '-', '\\']) await write('\x1b[10;9H' + spinner);
  assert.equal(
    await page.evaluate(() => window.commits),
    emptyBefore,
    'Empty projections do not commit on spinner output',
  );
  await write('\x1b[1;1H\x1b[2K$$x^2');
  assert.equal(await page.evaluate(() => window.lastBlock), undefined);
  await write('$$');
  assert.equal(await page.evaluate(() => window.lastBlock.block.source), 'x^2');
  await write('\x1b[10;9H|');
  const richBefore = await page.evaluate(() => window.commits);
  for (const spinner of ['/', '-']) await write('\x1b[10;9H' + spinner);
  assert.equal(
    await page.evaluate(() => window.commits),
    richBefore,
    'Equal rich projections do not commit on spinner output',
  );
  await write('\x1b[1;1H\x1b[2K$$y^2$$');
  assert.equal(await page.evaluate(() => window.lastBlock.block.source), 'y^2');
  await page.evaluate(() => window.terminal.select(0, 0, 2));
  await page.waitForTimeout(50);
  assert.equal(
    await page
      .locator('.xterm-screen > div')
      .last()
      .evaluate((el) => el.style.visibility),
    'hidden',
  );
  await page.evaluate(() => {
    window.terminal.clearSelection();
    window.applyTheme('light');
  });
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.lastBlock.theme), 'light');

  // Exercise the shared download lifecycle with a real browser download.
  await page.clock.install();
  await page.evaluate(() => {
    window.revoked = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => {
      window.revoked.push(url);
      revoke(url);
    };
  });
  const downloading = page.waitForEvent('download');
  await page.evaluate(() => window.downloadBlob(new Blob(['synthetic download']), 'synthetic.txt'));
  const download = await downloading;
  assert.equal(download.suggestedFilename(), 'synthetic.txt');
  assert.equal(await page.locator('a[download]').count(), 0);
  assert.equal(await page.evaluate(() => window.revoked.length), 0);
  await page.clock.fastForward(60_001);
  assert.equal(await page.evaluate(() => window.revoked.length), 1);
  assert.equal(await download.failure(), null);
  assert.deepEqual(errors, []);
  console.log(
    'Rich-output commit suppression, source updates, selection/theme and download cleanup pass.',
  );
} finally {
  await browser.close();
}
