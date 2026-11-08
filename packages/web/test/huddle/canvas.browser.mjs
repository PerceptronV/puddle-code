/* global window */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
const draft = () =>
  page.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    return JSON.parse(
      monaco.editor
        .getModels()
        .find((model) => model.uri.path.endsWith('/layout.json'))
        .getValue(),
    );
  });
try {
  await page.goto(
    new URL('/test/huddle/fixture.html', process.env.PREVIEW_URL ?? 'http://localhost:5174/').href,
  );
  await page.waitForFunction(() => !!window.huddleFixture);
  await page.evaluate(() => window.huddleFixture.releaseProjects());
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByRole('button', { name: 'Review graph', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Huddle editor' });
  const run = editor.getByRole('button', { name: 'Run event', exact: true });
  await run.click();
  await editor.getByRole('button', { name: 'Apply position' }).waitFor();
  await page.waitForFunction(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    return monaco.editor.getModels().some((model) => model.uri.path.endsWith('/layout.json'));
  });
  assert.equal(await page.evaluate(() => window.huddleFixture.layout()), null);
  const move = async (dx, dy) => {
    const rect = await run.boundingBox();
    await page.mouse.move(rect.x + 35, rect.y + 20);
    await page.mouse.down();
    await page.mouse.move(rect.x + 35 + dx, rect.y + 20 + dy, { steps: 5 });
    await page.mouse.up();
  };
  await move(100, 60);
  assert.deepEqual((await draft()).nodes.run, { x: 100, y: 60 });
  assert.equal(await page.evaluate(() => window.huddleFixture.layout()), null);
  await editor.getByRole('button', { name: 'Undo move', exact: true }).click();
  assert.deepEqual((await draft()).nodes, {});
  await editor.getByRole('button', { name: 'Redo move', exact: true }).click();
  await editor.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await move(80, 32);
  assert.deepEqual((await draft()).nodes.run, { x: 200, y: 100 });
  await run.focus();
  await run.press('Shift+ArrowRight');
  await run.press('ArrowDown');
  assert.deepEqual((await draft()).nodes.run, { x: 250, y: 110 });
  await run.press('ControlOrMeta+z');
  assert.deepEqual((await draft()).nodes.run, { x: 250, y: 100 });
  await run.press('ControlOrMeta+Shift+z');
  const before = await draft();
  const rect = await run.boundingBox();
  await page.mouse.move(rect.x + 35, rect.y + 20);
  await page.mouse.down();
  await page.mouse.move(rect.x + 65, rect.y + 50, { steps: 3 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.deepEqual(await draft(), before);
  // A source editor changing the shared layout during a gesture wins over that stale gesture.
  const concurrent = await run.boundingBox();
  await page.mouse.move(concurrent.x + 35, concurrent.y + 20);
  await page.mouse.down();
  await page.mouse.move(concurrent.x + 55, concurrent.y + 35, { steps: 2 });
  await page.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    const model = monaco.editor
      .getModels()
      .find((model) => model.uri.path.endsWith('/layout.json'));
    const layout = JSON.parse(model.getValue());
    layout.nodes.run = { x: 275, y: 125 };
    model.pushStackElement();
    model.pushEditOperations(
      [],
      [{ range: model.getFullModelRange(), text: JSON.stringify(layout, null, 2) }],
      () => null,
    );
    model.pushStackElement();
  });
  await page.mouse.up();
  assert.deepEqual((await draft()).nodes.run, { x: 275, y: 125 });
  await editor.getByRole('button', { name: 'Undo move', exact: true }).click();
  assert.deepEqual(await draft(), before);
  const touch = await page.context().newCDPSession(page);
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  const touchRect = await run.boundingBox();
  const point = { x: touchRect.x + 35, y: touchRect.y + 20 };
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: point.x + 32, y: point.y + 16 }],
  });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.deepEqual((await draft()).nodes.run, { x: 290, y: 130 });
  await editor.getByRole('button', { name: 'Undo move', exact: true }).click();
  await touch.detach();
  await page.evaluate(() => window.huddleFixture.action('editor.save'));
  await page.waitForFunction(() => window.huddleFixture.layout()?.nodes.run?.x === 250);
  assert.equal(
    await page.evaluate(
      () =>
        window.huddleFixture.requests.find(
          (request) => request.method === 'PUT' && request.body?.expected_mtime_ms === -1,
        )?.body.expected_mtime_ms,
    ),
    -1,
  );
  await editor.getByRole('button', { name: 'Fit graph', exact: true }).click();
  await editor.getByRole('button', { name: 'Fit selected', exact: true }).click();
  const inspector = editor.getByRole('complementary', { name: 'Node inspector' });
  await inspector.getByLabel('X', { exact: true }).fill('1600');
  await inspector.getByRole('button', { name: 'Apply position' }).click();
  const viewport = editor.getByLabel('Huddle graph', { exact: true });
  const bounds = await viewport.boundingBox();
  await viewport.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await page.mouse.move(bounds.x + 100, bounds.y + 240);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 20, bounds.y + 240, { steps: 4 });
  await page.mouse.up();
  assert.ok((await viewport.evaluate((element) => element.scrollLeft)) > 50);
  assert.equal((await draft()).nodes.run.x, 1600);
  await editor.getByRole('button', { name: 'Undo move', exact: true }).click();
  await inspector.getByLabel('X', { exact: true }).fill('400');
  await inspector.getByLabel('Y', { exact: true }).fill('300');
  await inspector.getByRole('button', { name: 'Apply position' }).click();
  await page.evaluate(() => window.huddleFixture.externalLayout({ run: { x: 600, y: 500 } }));
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await editor
    .getByText('The layout changed on disk. Your edits are intact.', { exact: false })
    .waitFor();
  assert.deepEqual((await draft()).nodes.run, { x: 400, y: 300 });
  assert.deepEqual(await page.evaluate(() => window.huddleFixture.layout().nodes.run), {
    x: 600,
    y: 500,
  });
  await editor.getByRole('button', { name: 'Compare layout', exact: true }).click();
  await page.evaluate(() => window.huddleFixture.failLayoutRead(true));
  await editor.getByRole('button', { name: 'Take the disk version', exact: true }).click();
  await editor.getByText('Layout: Layout read failed', { exact: true }).waitFor();
  assert.deepEqual((await draft()).nodes.run, { x: 400, y: 300 });
  await page.evaluate(() => window.huddleFixture.failLayoutRead(false));
  await editor.getByRole('button', { name: 'Take the disk version', exact: true }).click();
  await page.waitForFunction(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    return (
      JSON.parse(
        monaco.editor
          .getModels()
          .find((model) => model.uri.path.endsWith('/layout.json'))
          .getValue(),
      ).nodes.run.x === 600
    );
  });
  await editor.getByRole('button', { name: 'Fit graph', exact: true }).click();
  await run.focus();
  await run.press('ArrowLeft');
  const tab = page.locator('[data-pane-tab="huddle:00000000-0000-4000-8000-000000000003"]');
  await tab.hover();
  await tab.getByRole('button', { name: 'Close Review graph', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByText('Discard changes to Review graph?', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await editor.getByRole('button', { name: 'Open layout', exact: true }).click();
  await page.waitForSelector('.monaco-editor');
  await tab.click({ position: { x: 10, y: 2 } });
  await tab.hover();
  await tab.getByRole('button', { name: 'Close Review graph', exact: true }).click();
  await tab.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('dialog').count(), 0);
  const sourceTab = page.locator('[data-pane-tab]').filter({ hasText: 'layout.json' });
  await sourceTab.hover();
  await sourceTab.getByRole('button', { name: 'Close layout.json', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByText('Discard changes to layout.json?', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  assert.equal(
    await page.evaluate(() =>
      window.huddleFixture.requests.some((request) => /\/(start|run|resume)$/.test(request.path)),
    ),
    false,
  );
  assert.deepEqual(errors, []);
  await page.goto(
    new URL(
      '/test/huddle/fixture.html?old-layout',
      process.env.PREVIEW_URL ?? 'http://localhost:5174/',
    ).href,
  );
  await page.waitForFunction(() => !!window.huddleFixture);
  await page.evaluate(() => window.huddleFixture.releaseProjects());
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByRole('button', { name: 'Review graph', exact: true }).click();
  await run.click();
  assert.equal(await editor.getByRole('button', { name: 'Apply position' }).isDisabled(), true);
  await move(100, 60);
  assert.equal(
    await page.evaluate(() =>
      window.huddleFixture.requests.some((request) => request.method === 'PUT'),
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    'Huddle canvas: zoom-aware drag, keyboard movement, cancellation, guarded layout creation, conflicts and shared-source close review pass.',
  );
} catch (error) {
  console.error('Browser errors:', errors);
  console.error(await page.locator('body').innerText());
  await page.screenshot({ path: '/tmp/puddle-huddle-canvas-failure.png' });
  throw error;
} finally {
  await browser.close();
}
