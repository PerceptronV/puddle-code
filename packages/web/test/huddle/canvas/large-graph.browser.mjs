/* global window, performance, requestAnimationFrame, document */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(30_000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
try {
  await page.goto(
    new URL(
      '/test/huddle/fixture.html?large-graph',
      process.env.PREVIEW_URL ?? 'http://localhost:5174/',
    ).href,
  );
  await page.waitForFunction(() => !!window.huddleFixture);
  await page.evaluate(() => window.huddleFixture.releaseProjects());
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  const started = performance.now();
  await page.getByRole('button', { name: 'Review graph', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Huddle editor' });
  const viewport = editor.getByLabel('Huddle graph', { exact: true });
  await viewport.getByRole('button', { name: 'Input n0.in0', exact: true }).waitFor();
  const counts = () =>
    viewport.evaluate((element) => ({
      nodes: element.querySelectorAll('.island-outline').length,
      wires: element.querySelectorAll('svg [role="button"]').length,
      elements: element.querySelectorAll('*').length,
    }));
  const initial = await counts();
  const openMs = performance.now() - started;
  const frames = await viewport.evaluate(async (element) => {
    const samples = [];
    for (let i = 0; i < 32; i++) {
      const start = performance.now();
      element.scrollLeft = (i % 8) * 650;
      element.scrollTop = Math.floor(i / 8) * 900;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      samples.push(performance.now() - start);
    }
    return samples.sort((a, b) => a - b);
  });
  console.log(
    JSON.stringify({
      initial,
      afterPan: await counts(),
      openMs: Math.round(openMs),
      scrollTwoFrameP95Ms: Math.round(frames[Math.floor(frames.length * 0.95)]),
    }),
  );
  if (!process.argv.includes('--measure-only')) {
    assert.ok(initial.nodes < 32, `Expected viewport culling: ${JSON.stringify(initial)}`);
    assert.ok(initial.wires < 256);
    const node = (id) => viewport.locator(`[data-huddle-node="${id}"]`);
    const edge = (id) => viewport.locator(`[data-huddle-edge="${id}"]`);
    const pan = async (x, y) => {
      await viewport.evaluate(
        async (element, position) => {
          element.scrollLeft = position.x;
          element.scrollTop = position.y;
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        },
        { x, y },
      );
    };
    const unfocus = () => viewport.evaluate((element) => element.focus({ preventScroll: true }));
    // Long wires crossing the visible pane survive even when both endpoint nodes are culled.
    await pan(3000, 2400);
    assert.equal(await node('n0').count(), 0);
    assert.equal(await node('n255').count(), 0);
    assert.equal(await edge('long15').count(), 1);
    assert.equal(
      await edge('long15')
        .locator('path')
        .first()
        .evaluate((path) => {
          const view = path.closest('[aria-label="Huddle graph"]').getBoundingClientRect();
          const length = path.getTotalLength();
          return Array.from({ length: 101 }, (_, i) => {
            const point = path
              .getPointAtLength((length * i) / 100)
              .matrixTransform(path.getScreenCTM());
            return (
              point.x >= view.left &&
              point.x <= view.right &&
              point.y >= view.top &&
              point.y <= view.bottom
            );
          }).some(Boolean);
        }),
      true,
    );

    // Keyboard focus pins an unselected socket and an unselected SVG wire, then releases them.
    const input = viewport.getByRole('button', { name: 'Input n119.in0', exact: true });
    await input.evaluate((element) => element.focus({ preventScroll: true }));
    await pan(0, 0);
    assert.equal(await input.evaluate((element) => document.activeElement === element), true);
    await unfocus();
    await node('n119').waitFor({ state: 'detached' });
    await pan(3000, 2400);
    const wire = edge('e119_0').getByRole('button');
    await wire.evaluate((element) => element.focus({ preventScroll: true }));
    await pan(0, 0);
    assert.equal(await wire.evaluate((element) => document.activeElement === element), true);
    await unfocus();
    await edge('e119_0').waitFor({ state: 'detached' });

    // A selected connection remains inspectable off screen after focus leaves it.
    await pan(3000, 2400);
    await wire.press('Enter');
    await unfocus();
    await pan(0, 0);
    assert.equal(await wire.getAttribute('aria-pressed'), 'true');

    // A pending connection retains its source even when keyboard focus moves elsewhere.
    await viewport.getByRole('button', { name: 'Output n0.out7', exact: true }).press('Enter');
    await unfocus();
    await pan(6000, 5000);
    assert.equal(await node('n0').count(), 1);
    await page.keyboard.press('Escape');
    await node('n0').waitFor({ state: 'detached' });

    // Pointer capture survives scrolling during a node drag; Escape leaves the source untouched.
    await pan(0, 0);
    const header = node('n0').locator('button').first();
    const rect = await header.boundingBox();
    await page.mouse.move(rect.x + 30, rect.y + 16);
    await page.mouse.down();
    await page.mouse.move(rect.x + 50, rect.y + 26);
    await pan(6000, 5000);
    assert.equal(await header.evaluate((element) => element.hasPointerCapture(1)), true);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await unfocus();
    assert.equal(await node('n0').count(), 1); // selected independently of focus

    // The complete accessible list can reveal a previously culled node.
    await editor.getByRole('button', { name: 'Node list', exact: true }).click();
    await editor.getByRole('button', { name: 'Fixture n255', exact: true }).click();
    await editor.getByRole('button', { name: 'Graph', exact: true }).click();
    await editor.getByRole('button', { name: 'Fit selected', exact: true }).click();
    assert.equal(
      await node('n255').getByRole('button').first().getAttribute('aria-pressed'),
      'true',
    );
    await editor.getByRole('button', { name: 'Fit graph', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-huddle-node]').length === 256,
    );
    assert.equal(await edge('long15').count(), 1);
    assert.equal((await counts()).wires, 1024);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => window.huddleFixture.theme('dark'));
    await page.setViewportSize({ width: 1100, height: 750 });
    await editor.getByRole('button', { name: 'Fit selected', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-huddle-node]').length < 32);
    await page.screenshot({ path: '/tmp/huddle-culling-dark.png' });
    assert.equal(
      await page.evaluate(() =>
        window.huddleFixture.requests.some(
          (request) =>
            (request.method === 'PUT' && request.path.includes('/file')) ||
            /\/(start|apply|arm|run|interrupt|stop)$/.test(request.path),
        ),
      ),
      false,
    );
    const source = await page.evaluate(() => window.huddleFixture.source());
    assert.equal(source.nodes.length, 256);
    assert.equal(source.edges.length, 1024);
    assert.equal(
      await page.evaluate(async () => {
        const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
        const layout = monaco.editor
          .getModels()
          .find((model) => model.uri.path.endsWith('/layout.json'));
        return (
          JSON.stringify(JSON.parse(layout.getValue())) ===
          JSON.stringify(window.huddleFixture.layout())
        );
      }),
      true,
    );
    console.log(
      'Large-graph crossing wires, focus/selection, gestures, list reveal, fit and resize passed.',
    );
  }
  assert.deepEqual(errors, []);
} catch (error) {
  console.error(await page.locator('body').innerText());
  console.error(errors);
  throw error;
} finally {
  await browser.close();
}
