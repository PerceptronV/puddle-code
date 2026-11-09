/* global window */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./parked-view-entry.tsx', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  loader: { '.css': 'empty' },
});
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://terminal.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('https://terminal.test/');
  await page.addStyleTag({
    content:
      readFileSync(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8') +
      '\n.size-full {width:100%;height:100%}.hidden {display:none}',
  });
  await page.clock.install();
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => window.ready());
  const ids = Array.from({ length: 10 }, (_, i) => `view-${i}`);
  const show = async (active, side = 'left', open = ids) => {
    await page.evaluate(({ active, open, side }) => window.show(active, open, side), {
      active,
      open,
      side,
    });
    await page.clock.runFor(100);
    if (active) {
      await expect
        .poll(async () => {
          assert.deepEqual(errors, [], 'terminal fixture page errors');
          await page.clock.runFor(100);
          return page.evaluate((id) => window.state(id).live, active);
        })
        .toBe(true);
      await page.evaluate((id) => window.drain(id), active);
    }
  };
  await show(null);
  assert.deepEqual(
    (await page.evaluate(() => window.stats())).live,
    [],
    'unvisited parked projects allocate no terminals',
  );
  await show(ids[0]);
  const initial = await page.evaluate((id) => window.state(id), ids[0]);
  assert(initial.lines.some((line) => line.includes('synthetic view-0')));
  await show(ids[0], 'right');
  const moved = await page.evaluate((id) => window.state(id), ids[0]);
  assert.equal(moved.mounts, initial.mounts, 'moving between panes preserves xterm');
  assert.equal(moved.parent, 'right');
  await page.evaluate((id) => window.scroll(id, 5), ids[0]);
  const before = await page.evaluate((id) => window.state(id), ids[0]);
  for (const id of ids.slice(1)) {
    await show(id);
    if (id === ids[1]) await page.evaluate((id) => window.select(id), id);
    if (id === ids[2]) {
      await page.locator('[data-notification-session="view-2"] textarea').focus();
      await page.keyboard.press('ControlOrMeta+f');
    }
  }
  await show(null);
  await page.clock.runFor(1600); // detach linger
  await page.clock.fastForward(60_000);
  for (let i = 0; i < 9; i++) await page.clock.runFor(1100);
  assert.deepEqual(
    (await page.evaluate(() => window.stats())).live.sort(),
    [ids[1], ids[2], ...ids.slice(-3)],
    'three recent parked views plus active selection/find stay warm',
  );
  await page.evaluate(() => window.disconnect());
  await show(ids[0]);
  const restored = await page.evaluate((id) => window.state(id), ids[0]);
  assert.equal(restored.mounts, initial.mounts + 1);
  assert.deepEqual(restored.lines, before.lines, 'local transcript survives a disconnected return');
  assert.equal(restored.viewport, before.viewport, 'local scroll position survives');
  await page.evaluate((id) => window.select(id), ids[0]);
  assert.equal(
    await page.evaluate((id) => window.copy(id), ids[0]),
    'synthetic',
    'disconnected local copy',
  );
  const inputs = async () =>
    (await page.evaluate(() => window.stats())).sent.filter((message) => message.t === 'stdin');
  await page.evaluate((id) => window.input(id, 'blocked'), ids[0]);
  assert.deepEqual(await inputs(), [], 'local fallback does not authorise input');
  await page.clock.runFor(1000);
  await page.evaluate(() => window.reconnect());
  await page.evaluate(
    (id) => window.emit({ t: 'exit', session: id, term: 'agent', code: 0 }),
    ids[0],
  );
  assert.deepEqual(
    (await page.evaluate((id) => window.state(id), ids[0])).lines,
    before.lines,
    'confirmed exit keeps transcript',
  );
  await page.evaluate(
    (id) => window.emit({ t: 'status', session: id, status: 'running', last_activity_at: null }),
    ids[0],
  );
  await page.evaluate((id) => window.input(id, 'still-blocked'), ids[0]);
  assert.deepEqual(await inputs(), [], 'resume waits for fresh replay');
  await page.evaluate(
    (id) => window.emit({ t: 'replay', session: id, term: 'agent', data: 'fresh generation' }),
    ids[0],
  );
  await page.evaluate((id) => window.drain(id), ids[0]);
  await page.evaluate((id) => window.input(id, 'allowed'), ids[0]);
  assert.deepEqual(
    (await inputs()).map((message) => message.data),
    ['allowed'],
    'no stale keystrokes buffered',
  );
  await show(null, 'left', []);
  assert.deepEqual(
    (await page.evaluate(() => window.stats())).live,
    [],
    'closing all tabs releases terminals',
  );
  await page.evaluate(() => window.mobile(true));
  await page.clock.runFor(200);
  await page.evaluate(() => window.drain('mobile'));
  await page.evaluate(() =>
    window.emit({
      t: 'replay',
      session: 'mobile',
      term: 'agent',
      data: 'mobile offline transcript',
    }),
  );
  await page.evaluate(() => window.drain('mobile'));
  await page.evaluate(() => {
    window.disconnect();
    window.mobile(false);
  });
  await page.clock.fastForward(120_000);
  const mobile = await page.evaluate(() => window.state('mobile'));
  assert.equal(mobile.live, true, 'visible disconnected mobile terminal cannot be parked');
  assert(mobile.lines.some((line) => line.includes('mobile offline transcript')));
  await page.evaluate(() => window.shutdown());
  assert.deepEqual(errors, []);
  console.log(
    'Actual Terminal/KeepAliveHost: lazy parked allocation, stable pane moves, warm budget, disconnected/exited transcript and copy, fresh resume input gate, and close cleanup pass.',
  );
} finally {
  await browser.close();
}
