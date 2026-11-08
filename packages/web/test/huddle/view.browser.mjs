/* global window, document, DataTransfer, DragEvent */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const editor = page.getByRole('region', { name: 'Huddle editor' });
const graph = editor.getByLabel('Huddle graph', { exact: true });
const tab = page.locator('[data-pane-tab="huddle:00000000-0000-4000-8000-000000000003"]');
async function setup() {
  await page.waitForFunction(() => !!window.huddleFixture);
  await page.evaluate(() => {
    window.huddleFixture.externalLayout({ run: { x: 0, y: 0 }, result: { x: 1600, y: 1100 } });
    window.huddleFixture.releaseProjects();
  });
}
const camera = () => graph.evaluate((element) => ({ x: element.scrollLeft, y: element.scrollTop }));
async function expectCamera(expected) {
  await page.waitForFunction(({ x, y }) => {
    const element = document.querySelector('[aria-label="Huddle graph"]');
    return element && Math.abs(element.scrollLeft - x) < 2 && Math.abs(element.scrollTop - y) < 2;
  }, expected);
  assert.match(
    await editor.getByRole('button', { name: 'Reset zoom', exact: true }).innerText(),
    /125%/,
  );
}
try {
  await page.goto(
    new URL(
      '/test/huddle/fixture.html?view-state',
      process.env.PREVIEW_URL ?? 'http://127.0.0.1:5189/',
    ).href,
  );
  await setup();
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByRole('button', { name: 'Review graph', exact: true }).click();
  await editor.getByRole('button', { name: 'Run event', exact: true }).click();
  await editor
    .getByRole('button', { name: 'Connection run.event to result.value', exact: true })
    .press('Enter');
  await editor.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await graph.evaluate((element) => {
    element.scrollLeft = 700;
    element.scrollTop = 500;
  });
  await expectCamera({ x: 700, y: 500 });
  // Mode and selected inspector survive canvas remounting, while navigation never dirties source.
  await editor.getByRole('button', { name: 'Node list', exact: true }).click();
  await editor.getByRole('button', { name: 'Result result', exact: true }).click();
  await editor.getByRole('button', { name: 'Graph', exact: true }).click();
  await expectCamera({ x: 700, y: 500 });
  await editor
    .getByRole('complementary', { name: 'Node inspector' })
    .getByRole('heading', { name: 'Result' })
    .waitFor();
  await editor.getByRole('button', { name: 'Open definition', exact: true }).click();
  await page.waitForSelector('.monaco-editor');
  await tab.click({ position: { x: 10, y: 2 } });
  await expectCamera({ x: 700, y: 500 });
  await tab.hover();
  await tab.getByRole('button', { name: 'Close Review graph', exact: true }).click();
  await editor.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByRole('button', { name: 'Review graph', exact: true }).click();
  await expectCamera({ x: 700, y: 500 });
  await editor
    .getByRole('complementary', { name: 'Node inspector' })
    .getByRole('heading', { name: 'Result' })
    .waitFor();
  // Browser working-set recovery includes the private graph view, never layout.json.
  await page.reload();
  await setup();
  await expectCamera({ x: 700, y: 500 });
  assert.equal(
    await editor
      .getByRole('button', { name: 'Connection run.event to result.value', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  );
  await editor
    .getByRole('complementary', { name: 'Node inspector' })
    .getByRole('heading', { name: 'Result' })
    .waitFor();
  const expected = await camera();
  await page.setViewportSize({ width: 2200, height: 1400 });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expectCamera(expected);
  // A real tab gesture moves the huddle into a new pane with its view intact.
  const start = await tab.boundingBox();
  const body = await page.locator('[data-pane-drop-target]').first().boundingBox();
  await page.mouse.move(start.x + 25, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + 40, start.y + start.height / 2, { steps: 3 });
  await page.mouse.move(body.x + body.width - 8, body.y + body.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-pane-drop-target]').length === 2,
  );
  await expectCamera(expected);
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.evaluate(() => window.huddleFixture.theme('dark'));
  await editor.getByRole('button', { name: 'Node list', exact: true }).click();
  await page.reload();
  await setup();
  await editor.getByRole('button', { name: 'Graph', exact: true }).waitFor();
  await editor.getByRole('button', { name: 'Graph', exact: true }).click();
  await expectCamera(expected);
  // Opening a second view through the sidebar's drag payload keeps navigation independent.
  await page.evaluate(() => {
    const target = document.querySelectorAll('[data-pane-drop-target]')[0];
    const bounds = target.getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    dataTransfer.setData(
      'application/x-puddle-tab',
      JSON.stringify({ type: 'huddle', session: window.huddleFixture.saved }),
    );
    target.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: bounds.x + bounds.width / 2,
        clientY: bounds.y + bounds.height / 2,
      }),
    );
  });
  await page.waitForFunction(
    () => document.querySelectorAll('[aria-label="Huddle editor"]').length === 2,
  );
  await editor.first().getByRole('button', { name: 'Reset zoom', exact: true }).click();
  assert.match(
    await editor.first().getByRole('button', { name: 'Reset zoom', exact: true }).innerText(),
    /100%/,
  );
  assert.match(
    await editor.last().getByRole('button', { name: 'Reset zoom', exact: true }).innerText(),
    /125%/,
  );
  await page.screenshot({ path: '/tmp/huddle-view-dark.png' });
  assert.equal(await editor.getByText('Unsaved changes', { exact: true }).count(), 0);
  assert.equal(
    await page.evaluate(() =>
      window.huddleFixture.requests.some(
        (request) =>
          (request.method !== 'GET' &&
            /\/(start|run|apply|stop|interrupt|rearm)$/.test(request.path)) ||
          (request.method === 'PUT' && request.path.includes('/file')),
      ),
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: huddle camera/selection/mode across tabs, close/reopen, reload, resize and pane move; no source writes or runtime commands',
  );
} catch (error) {
  console.error(errors);
  console.error(await page.locator('body').innerText());
  await page.screenshot({ path: '/tmp/huddle-view-failure.png' });
  throw error;
} finally {
  await browser.close();
}
