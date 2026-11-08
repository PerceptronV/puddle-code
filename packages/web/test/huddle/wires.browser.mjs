/* global window */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
const graph = () =>
  page.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    return JSON.parse(
      monaco.editor
        .getModels()
        .find((model) => model.uri.path.endsWith('/huddle.json'))
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
  const output = editor.getByRole('button', { name: 'Output run.event', exact: true });
  const input = editor.getByRole('button', { name: 'Input result.value', exact: true });
  const connection = editor.getByRole('button', {
    name: 'Connection run.event to result.value',
    exact: true,
  });
  const points = async () => {
    const from = await output.boundingBox(),
      to = await input.boundingBox();
    return {
      from: { x: from.x + from.width - 3, y: from.y + from.height / 2 },
      to: { x: to.x + 3, y: to.y + to.height / 2 },
    };
  };
  const begin = async () => {
    const { from, to } = await points();
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
  };
  const remove = async () => {
    await connection.focus();
    await connection.press('Delete');
  };
  await output.waitFor();
  await remove();
  assert.equal((await graph()).edges.length, 0);
  await begin();
  await page.mouse.up();
  assert.equal((await graph()).edges.length, 1);
  assert.equal(
    await editor.getByRole('button', { name: 'Cancel connection', exact: true }).count(),
    0,
  );
  await editor.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal((await graph()).edges.length, 0);
  await editor.getByRole('button', { name: 'Redo', exact: true }).click();
  assert.equal((await graph()).edges.length, 1);
  await output.click();
  await input.click();
  await editor.getByText('This connection already exists.', { exact: true }).waitFor();
  assert.equal((await graph()).edges.length, 1);
  await editor.getByRole('button', { name: 'Cancel connection', exact: true }).click();
  await remove();
  await output.focus();
  await output.press('Enter');
  await input.focus();
  await input.press('Enter');
  assert.equal((await graph()).edges.length, 1);
  await remove();
  await begin();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal((await graph()).edges.length, 0);
  assert.equal(
    await editor.getByRole('button', { name: 'Cancel connection', exact: true }).count(),
    0,
  );
  await output.click();
  await page.keyboard.press('Escape');
  await input.click();
  assert.equal((await graph()).edges.length, 0);
  // Concurrent source edits cannot turn a stale gesture into a new connection.
  await begin();
  await page.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    const model = monaco.editor.getModels().find((item) => item.uri.path.endsWith('/huddle.json'));
    const next = JSON.parse(model.getValue());
    next.name = 'Changed during wiring';
    model.pushEditOperations(
      [],
      [{ range: model.getFullModelRange(), text: JSON.stringify(next, null, 2) }],
      () => null,
    );
  });
  await page.mouse.up();
  assert.equal((await graph()).edges.length, 0);
  assert.equal((await graph()).name, 'Changed during wiring');
  await editor.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await begin();
  await page.mouse.up();
  assert.equal((await graph()).edges.length, 1);
  await remove();
  const cdp = await page.context().newCDPSession(page);
  const { from, to } = await points();
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...from, id: 1 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ ...to, id: 1 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await connection.waitFor({ state: 'attached' });
  assert.equal((await graph()).edges.length, 1);
  await remove();
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...from, id: 1 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ ...to, id: 1 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  assert.equal((await graph()).edges.length, 0);
  await begin();
  await page.mouse.move(to.x + 100, to.y + 140);
  await page.mouse.up();
  assert.equal((await graph()).edges.length, 0);
  await output.click();
  await input.click();
  const selected = await points();
  await page.mouse.click(
    (selected.from.x + selected.to.x) / 2,
    (selected.from.y + selected.to.y) / 2,
  );
  await editor.getByRole('button', { name: 'Disconnect selected', exact: true }).click();
  assert.equal((await graph()).edges.length, 0);
  await output.click();
  await input.click();
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => window.huddleFixture.source().edges[0]?.id !== 'result-edge');
  assert.equal(await page.evaluate(() => window.huddleFixture.source().edges.length), 1);
  assert.equal(
    await page.evaluate(() =>
      window.huddleFixture.requests.some((request) =>
        /\/(start|apply|run|rearm|interrupt|stop)$/.test(request.path),
      ),
    ),
    false,
  );
  await page.screenshot({ path: '/tmp/puddle-huddle-wires.png' });
  assert.deepEqual(errors, []);
  console.log(
    'Huddle wires: pointer/touch and keyboard creation, cancellation, stale drafts, duplicate rejection, undo/redo, disconnect and save pass without execution.',
  );
} catch (error) {
  console.error('Browser errors:', errors);
  console.error(await page.locator('body').innerText());
  await page.screenshot({ path: '/tmp/puddle-huddle-wires-failure.png' });
  throw error;
} finally {
  await browser.close();
}
