/* global window */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    new URL('/test/dev/explorer-fixture.html', process.env.PREVIEW_URL ?? 'http://localhost:5174/')
      .href,
  );
  await page.waitForFunction(() => window.explorerFixture?.explorer()?.visibleRows.length > 2);
  const before = await page.evaluate(() => window.explorerFixture.controlsRenders());
  for (let i = 0; i < 30; i++) {
    await page.evaluate((i) => {
      const ex = window.explorerFixture.explorer();
      ex.selectOnly(ex.visibleRows[i % ex.visibleRows.length].path);
    }, i);
    await page.evaluate(() => new Promise(window.requestAnimationFrame));
  }
  const renders = (await page.evaluate(() => window.explorerFixture.controlsRenders())) - before;
  console.log(`Header-controls context renders during 30 selection changes: ${renders}`);
  assert.equal(renders, 0);
  const frame = () => page.evaluate(() => new Promise(window.requestAnimationFrame));
  // Real keyboard events exercise visible-row navigation and range selection.
  await page.evaluate(() => {
    const ex = window.explorerFixture.explorer();
    ex.selectOnly(ex.visibleRows[0].path);
  });
  await frame();
  await page.getByRole('tree').focus();
  await page.keyboard.press('Shift+ArrowDown');
  assert.equal(await page.evaluate(() => window.explorerFixture.explorer().selection.size), 2);
  await page.evaluate(() => window.explorerFixture.explorer().selectOnly('docs'));
  await frame();
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector('[data-path="docs/design.md"]');
  await page.keyboard.press('ArrowRight');
  assert.equal(
    await page.evaluate(() => window.explorerFixture.explorer().focusedPath),
    'docs/design.md',
  );
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => window.explorerFixture.explorer().focusedPath), 'docs');
  await page.keyboard.press('ArrowLeft');
  assert.equal(
    await page.evaluate(() => window.explorerFixture.explorer().expanded.has('docs')),
    false,
  );
  await page.keyboard.press('p');
  assert.equal(
    await page.evaluate(() => window.explorerFixture.explorer().focusedPath),
    'packages',
  );
  // Reveal ignores another directory, then expands and selects the matching one.
  await page.evaluate(() =>
    window.explorerFixture.reveal({ path: 'docs/design.md', directory: '/another-tree' }),
  );
  assert.notEqual(
    await page.evaluate(() => window.explorerFixture.explorer().focusedPath),
    'docs/design.md',
  );
  await page.evaluate(() =>
    window.explorerFixture.reveal({
      path: 'docs/design.md',
      directory: window.explorerFixture.explorer().rootPath,
    }),
  );
  await page.waitForSelector('[data-path="docs/design.md"]');
  assert.equal(
    await page.evaluate(() => window.explorerFixture.explorer().focusedPath),
    'docs/design.md',
  );
  await page.keyboard.press('F2');
  await page.waitForFunction(() => window.explorerFixture.explorer().editing?.mode === 'rename');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.explorerFixture.explorer().editing === null);
  // Directory selections prune children; foreign-host clipboard cannot mutate.
  await page.evaluate(() => window.explorerFixture.explorer().copy(['docs', 'docs/design.md']));
  await frame();
  assert.deepEqual(await page.evaluate(() => window.explorerFixture.explorer().clipboard.paths), [
    'docs',
  ]);
  await page.evaluate(() => {
    const f = window.explorerFixture;
    f.clipboard(['README.md'], 'copy', {
      sid: f.explorer().sid,
      directory: f.explorer().rootPath,
      host: 'foreign-host',
    });
  });
  await frame();
  const postsBefore = await page.evaluate(
    () => window.explorerFixture.requests.filter((r) => r.method === 'POST').length,
  );
  await page.evaluate(() => window.explorerFixture.explorer().paste(''));
  await frame();
  assert.equal(await page.evaluate(() => window.explorerFixture.explorer().canPaste), false);
  assert.equal(
    await page.evaluate(
      () => window.explorerFixture.requests.filter((r) => r.method === 'POST').length,
    ),
    postsBefore,
  );
  // Read-only changes after opening an edit/confirmation still prevent mutation.
  await page.evaluate(() => {
    const ex = window.explorerFixture.explorer();
    ex.beginRename('README.md');
    ex.requestDelete(['docs', 'docs/design.md']);
  });
  await frame();
  assert.deepEqual(await page.evaluate(() => window.explorerFixture.explorer().pendingDelete), [
    'docs',
  ]);
  await page.evaluate(() => window.explorerFixture.readOnly(true));
  await frame();
  await page.evaluate(() => {
    const ex = window.explorerFixture.explorer();
    ex.commitEdit('changed.md');
    ex.confirmDelete();
    ex.onInternalDrop('docs', ['README.md']);
  });
  await frame();
  assert.equal(
    await page.evaluate(
      () => window.explorerFixture.requests.filter((r) => r.method === 'POST').length,
    ),
    postsBefore,
  );
  await page.evaluate(() => window.explorerFixture.readOnly(false));
  await frame();
  // An accepted create can finish on its original tree without opening in a new visit.
  await page.evaluate(() => {
    const f = window.explorerFixture;
    f.holdCreate();
    f.explorer().beginCreate('', 'file');
  });
  await frame();
  await page.evaluate(() => window.explorerFixture.explorer().commitEdit('late.md'));
  await page.waitForFunction(() =>
    window.explorerFixture.requests.some((r) => r.path.includes('/create')),
  );
  await page.evaluate(() => window.explorerFixture.root('/synthetic/other'));
  await page.waitForFunction(() => window.explorerFixture.explorer().root === '/synthetic/other');
  assert.equal(await page.evaluate(() => window.explorerFixture.explorer().selection.size), 0);
  await page.evaluate(() => window.explorerFixture.root(undefined));
  await page.waitForFunction(() => window.explorerFixture.explorer().root === undefined);
  await page.evaluate(() => window.explorerFixture.releaseCreate());
  await frame();
  await frame();
  assert.equal(await page.evaluate(() => window.explorerFixture.opened.includes('late.md')), false);
  await page.evaluate(() => window.explorerFixture.explorer().beginCreate('', 'file'));
  await frame();
  await page.evaluate(() => window.explorerFixture.explorer().commitEdit('current.md'));
  await page.waitForFunction(() => window.explorerFixture.opened.includes('current.md'));
  console.log(
    'Explorer keyboard/range/reveal, clipboard admission, read-only actions and delayed create ownership pass.',
  );
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
