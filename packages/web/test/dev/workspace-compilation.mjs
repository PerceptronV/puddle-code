/* global window */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.PREVIEW_URL ?? 'http://localhost:5174/');
  const mount = () =>
    page.evaluate(async () => {
      const { mountCompilation } = await import('/test/dev/workspace-compilation-fixture.tsx');
      window.compilationFixture = mountCompilation();
    });
  const state = () => page.evaluate(() => window.compilationFixture.state());
  const remove = () => page.evaluate(() => window.compilationFixture.remove());

  await mount();
  await page.evaluate(() => window.compilationFixture.runTwice());
  await page.waitForFunction(() => window.compilationFixture.state().calls.length === 1);
  assert.equal((await state()).saves, 1);
  await page.evaluate(async () => {
    window.compilationFixture.finish(0);
    await window.compilationFixture.settled();
  });
  assert.equal((await state()).events.filter((e) => e.open).length, 1);
  assert.equal((await state()).calls[0].body.project_id, 'aaaaaaaaaa');
  await remove();

  // A project visit change while saving must prevent dispatch, even after returning.
  await mount();
  await page.evaluate(() => {
    window.finishSave = window.compilationFixture.blockSave();
    window.compilationFixture.run();
  });
  await page.waitForFunction(() => window.compilationFixture.state().saves === 1);
  await page.evaluate(() => {
    window.compilationFixture.project('bbbbbbbbbb');
    window.compilationFixture.project('aaaaaaaaaa');
    window.finishSave(true);
  });
  await page.evaluate(() => window.compilationFixture.settled());
  assert.equal((await state()).calls.length, 0);
  await remove();

  // A dispatched run may finish on the host, but cannot open in a different layout.
  await mount();
  await page.evaluate(() => window.compilationFixture.run());
  await page.waitForFunction(() => window.compilationFixture.state().calls.length === 1);
  await page.evaluate(async () => {
    window.compilationFixture.project('bbbbbbbbbb');
    window.compilationFixture.finish(0);
    await window.compilationFixture.settled();
  });
  assert.deepEqual((await state()).events, []);
  await remove();

  // Save rejection prevents eager enablement; late failures cannot undo a later choice.
  await mount();
  await page.evaluate(() => {
    window.finishSave = window.compilationFixture.blockSave();
    window.compilationFixture.changeMode('eager');
  });
  await page.waitForFunction(() => window.compilationFixture.state().saves === 1);
  await page.evaluate(async () => {
    window.finishSave(false);
    await window.compilationFixture.settled();
  });
  assert.equal((await state()).mode, 'on_demand');
  assert.equal((await state()).calls.length, 0);
  await remove();
  await mount();
  await page.evaluate(() => {
    window.compilationFixture.seedMode('eager');
    window.compilationFixture.changeMode('on_demand');
  });
  await page.waitForFunction(() => window.compilationFixture.state().calls.length === 1);
  await page.evaluate(async () => {
    window.compilationFixture.changeMode('eager');
    await window.compilationFixture.settled();
    window.compilationFixture.finish(
      0,
      { error: { code: 'failed', message: 'synthetic rejection' } },
      500,
    );
  });
  await page.waitForTimeout(50);
  assert.equal((await state()).mode, 'eager');
  await remove();
  assert.deepEqual(errors, []);
  console.log(
    'Workspace compilation preserves saves and targets, suppresses duplicate dispatch and ignores stale completions.',
  );
} finally {
  await browser.close();
}
