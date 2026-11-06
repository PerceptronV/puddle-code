/* global window */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./parked-snapshot-entry.ts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
});
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<body></body>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const history = Array.from(
    { length: 100 },
    (_, i) => `row ${i}: \x1b[31;1mred\x1b[0m 界 é ${'wrapped '.repeat(12)}`,
  ).join('\r\n');
  for (const [name, content, alternate] of [
    ['normal', history + '\x1b[3;7H\x1b[?25l\x1b[5 q\x1b[?2004h\x1b[?1h', false],
    ['empty', '', false],
  ]) {
    const result = await page.evaluate(
      ({ content, alternate }) => window.checkSnapshot(content, alternate),
      { content, alternate },
    );
    for (const key of Object.keys(result.before)) {
      // Compare row-wise so a failure identifies one row rather than dumping a whole transcript.
      if (key === 'lines')
        result.before.lines.forEach((line, index) =>
          assert.deepEqual(result.after.lines[index], line, `${name} row ${index}`),
        );
      else assert.deepEqual(result.after[key], result.before[key], `${name} ${key}`);
    }
    if (alternate)
      assert.deepEqual(
        result.normalAfter,
        result.normalBefore,
        'normal history behind alternate screen',
      );
  }
  assert.deepEqual(await page.evaluate(() => window.unsupported()), {
    selection: true,
    link: true,
    alternate: true,
    synchronised: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    'Parked snapshots preserve normal-buffer cells, attributes, wide/combining text, wraps, cursor, viewport and modes; alternate buffers and unsupported state stay warm.',
  );
} finally {
  await browser.close();
}
