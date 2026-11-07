/* global window */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.PREVIEW_URL ?? 'http://localhost:5174/');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('[data-path="package.json"]').dblclick();
  await page.waitForSelector('.puddle-hidden-diff-controller', { state: 'attached' });
  await page.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    const { files, modifiedTimes } = await import('/src/dev/preview/data.ts');
    const { browserTransport } = await import('/src/lib/transport/browser-transport.ts');
    const transport = browserTransport();
    if (transport?.scope !== 'ui-preview') throw new Error('Requires daemon-free preview');
    const original = transport.request.bind(transport);
    window.saves = [];
    transport.request = async (method, path, body, signal) => {
      const url = new URL(path, window.location.origin);
      if (method === 'PUT' && url.pathname.endsWith('/file')) {
        const name = url.searchParams.get('path');
        window.saves.push(body);
        if (body.expected_mtime_ms !== modifiedTimes.get(name))
          return window.Response.json(
            { error: { code: 'stale_file', message: 'Changed externally' } },
            { status: 409 },
          );
        if (body.content === files.get(name))
          return window.Response.json({
            path: name,
            mtime_ms: modifiedTimes.get(name),
            size: body.content.length,
          });
      }
      return original(method, path, body, signal);
    };
    window.edit = () => {
      const model = monaco.editor.getModels().find((m) => m.uri.path.endsWith('package.json'));
      if (!model) throw new Error('Editor missing');
      model.setValue(model.getValue() + '\n// local change');
      files.set('package.json', files.get('package.json') + '\n// external change');
      modifiedTimes.set('package.json', modifiedTimes.get('package.json') + 1);
      window.diskVersion = files.get('package.json');
      window.diskTime = modifiedTimes.get('package.json');
    };
    window.edit();
  });
  await page.keyboard.press('Meta+s');
  await page.getByRole('button', { name: 'Compare', exact: true }).waitFor();
  await page.keyboard.press('Meta+s');
  assert.equal(await page.evaluate(() => window.saves.length), 1, 'Unresolved save cannot retry');
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await page.getByRole('button', { name: 'Keep mine', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Take the disk version', exact: true }).click();
  await page
    .getByRole('button', { name: 'Take the disk version', exact: true })
    .waitFor({ state: 'detached' });
  assert.deepEqual(
    await page.evaluate(() => window.saves[1]),
    await page.evaluate(() => ({
      content: window.diskVersion,
      expected_mtime_ms: window.diskTime,
    })),
  );
  await page.keyboard.press('Meta+s');
  assert.equal(await page.evaluate(() => window.saves.length), 2, 'Clean save sends no write');

  // The shell must capture Command+Enter even while Monaco owns the caret.
  await page.locator('.monaco-editor textarea').first().focus();
  await page.waitForTimeout(100);
  await page.evaluate(async () => {
    const { registerHotkey } = await import('/src/lib/navigation/hotkeys.ts');
    window.compileCount = 0;
    window.compileProbe = () => window.compileCount++;
    registerHotkey('editor.compile', window.compileProbe);
  });
  await page.keyboard.press('Meta+Enter');
  assert.equal(await page.evaluate(() => window.compileCount), 1);
  assert.deepEqual(errors, []);
  console.log(
    'Editor conflict resolution acknowledges disk without writing; clean saves skip requests and Command+Enter reaches compilation.',
  );
} finally {
  await browser.close();
}
