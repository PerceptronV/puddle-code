/* global window, document, Event */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const baseline = process.env.PUDDLE_CURSOR_BASELINE === '1';
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./cursor-entry.tsx', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  plugins: baseline
    ? [
        {
          name: 'baseline',
          setup(build) {
            build.onLoad({ filter: /use-custom-cursor\.ts$/ }, () => ({
              contents: execFileSync(
                'git',
                ['show', 'e0c463e8:packages/web/src/features/cursor/use-custom-cursor.ts'],
                { encoding: 'utf8' },
              ),
              loader: 'ts',
              resolveDir: fileURLToPath(new URL('../../src/features/cursor/', import.meta.url)),
            }));
          },
        },
      ]
    : [],
});
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://cursor.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `
    <div id="root"></div><div id="parent" style="font-size:20px"><p id="text">Selectable text</p></div>
    <button id="button">Action</button><div class="monaco-editor" style="font-size:16px"><span id="editor">Editor</span></div>
    <h1 id="heading">Heading</h1><iframe id="frame"></iframe>`,
    }),
  );
  await page.goto('https://cursor.test/');
  await page.addStyleTag({
    content: readFileSync(new URL('../../src/styles/cursors.css', import.meta.url), 'utf8'),
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const cursor = page.locator('.custom-cursor');
  const choose = async (kind, reduced = false) => {
    await page.evaluate(({ kind, reduced }) => window.choose(kind, reduced), { kind, reduced });
    await page.waitForTimeout(30);
  };
  const move = async (id, count = 1, pointerType = 'mouse') => {
    await page.evaluate(({ id, count, pointerType }) => window.move(id, count, pointerType), {
      id,
      count,
      pointerType,
    });
    await page.evaluate(() => window.frame());
  };
  const results = [];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  for (const kind of ['system', 'rangefinder', 'invert']) {
    await choose(kind);
    await page.evaluate(() => window.resetCounts());
    const before = await cdp.send('Performance.getMetrics');
    const counts = await page.evaluate(() => window.workload());
    const after = await cdp.send('Performance.getMetrics');
    const prior = Object.fromEntries(before.metrics.map((metric) => [metric.name, metric.value]));
    const metrics = Object.fromEntries(
      after.metrics
        .filter((metric) =>
          [
            'TaskDuration',
            'ScriptDuration',
            'LayoutDuration',
            'RecalcStyleDuration',
            'LayoutCount',
          ].includes(metric.name),
        )
        .map((metric) => [metric.name, metric.value - prior[metric.name]]),
    );
    results.push({ kind, baseline, ...counts, metrics });
  }
  if (!baseline) {
    await choose('rangefinder');
    await move('text', 1000);
    await expect(cursor).toHaveClass(/is-text/);
    await expect(cursor).toHaveCSS('--custom-cursor-caret-height', '26px');
    await page.evaluate(() => window.resetCounts());
    await move('text', 1000);
    const counts = await page.evaluate(() => window.counts());
    assert.equal(counts.styleReads, 0, 'same target reuses computed style');
    assert.equal(counts.roleQueries, 0, 'same target reuses role');
    assert(counts.writes <= 2, 'one position/opacity write per frame');
    assert.equal(
      await page.evaluate(() => {
        const rect = document.getElementById('text').getBoundingClientRect();
        return (
          document.querySelector('.custom-cursor').style.transform ===
          `translate3d(${rect.x + 24}px, ${rect.y + 5}px, 0px) translate(-50%, -50%)`
        );
      }),
      true,
      'the final event in the burst wins',
    );
    await page.evaluate(() => {
      document.getElementById('parent').style.fontSize = '30px';
    });
    await page.evaluate(() => window.frame());
    await expect(cursor).toHaveCSS('--custom-cursor-caret-height', '39px');
    await page.evaluate(() => document.getElementById('parent').setAttribute('role', 'button'));
    await page.evaluate(() => window.frame());
    await expect(cursor).toHaveClass(/is-interactive/);
    await page.evaluate(() => document.getElementById('parent').removeAttribute('role'));
    await move('text');
    await page.evaluate(() => {
      const rect = document.getElementById('text').getBoundingClientRect();
      const overlay = document.createElement('button');
      overlay.id = 'overlay';
      Object.assign(overlay.style, {
        position: 'fixed',
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: '100px',
        height: '60px',
        zIndex: '10',
      });
      document.body.appendChild(overlay);
    });
    await page.evaluate(() => window.frame());
    await expect(cursor).toHaveClass(/is-interactive/);
    await page.evaluate(() => document.getElementById('overlay').remove());
    await page.evaluate(() => window.frame());
    await expect(cursor).toHaveClass(/is-text/);
    await page.evaluate(() => {
      document.getElementById('text').firstChild.textContent = '';
    });
    await page.evaluate(() => window.frame());
    await expect(cursor).not.toHaveClass(/is-text/);
    await page.evaluate(() => {
      document.getElementById('text').textContent = 'Selectable text';
    });
    await move('editor');
    await expect(cursor).toHaveClass(/is-text/);
    await move('heading');
    await expect(cursor).not.toHaveClass(/is-text/);
    await move('frame');
    await expect(cursor).toHaveCSS('opacity', '0');
    await move('text', 1, 'touch');
    await expect(cursor).toHaveCSS('opacity', '0');
    await choose('invert', true);
    await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true');
    await move('button');
    await expect(cursor).toHaveClass(/is-interactive/);
    await page.evaluate(() => {
      window.move('text', 100);
      window.dispatchEvent(new Event('blur'));
    });
    await page.evaluate(() => window.frame());
    await expect(cursor).toHaveCSS('opacity', '0');
    await move('text');
    await page.evaluate(() => window.resetCounts());
    await page.waitForTimeout(150);
    assert.deepEqual(
      await page.evaluate(() => window.counts()),
      { styleReads: 0, roleQueries: 0, writes: 0 },
      'no idle loop or self-invalidating observer',
    );
    await choose('system');
    await expect(cursor).toHaveCount(0);
    await page.evaluate(() => window.resetCounts());
    await move('text', 100);
    assert.deepEqual(
      await page.evaluate(() => window.counts()),
      { styleReads: 0, roleQueries: 0, writes: 0 },
      'system cursor removes listeners',
    );
  }
  assert.deepEqual(errors, []);
  if (process.env.PUDDLE_PROFILE_OUTPUT)
    writeFileSync(process.env.PUDDLE_PROFILE_OUTPUT, JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results));
  console.log(
    'Cursor movement, role/style invalidation, hiding, reduced-motion selection and cleanup pass.',
  );
} finally {
  await browser.close();
}
