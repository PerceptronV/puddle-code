/* global window, document, getComputedStyle, NodeFilter -- browser fixture */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    new URL(
      '/e2e/fixtures/ripple.html?live&ripple',
      process.env.PREVIEW_URL ?? 'http://127.0.0.1:5174/',
    ).href,
  );
  await page.waitForFunction(() => window.rippleFixture?.messages.some((m) => m.t === 'attach'));
  const size = await page.evaluate(() =>
    window.rippleFixture.messages.findLast((m) => m.t === 'resize' || m.t === 'attach'),
  );
  await page.evaluate(
    ({ rows }) =>
      window.rippleFixture.output(
        '\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[H› Past prompt\r\n' +
          Array.from(
            { length: Math.min(7, Math.floor((rows - 7) / 2)) },
            (_, i) => `• Row ${i + 1}\r\n\r\n`,
          ).join('') +
          `\x1b[${rows - 5};1HLAST COVERED ROW\x1b[${rows - 4};1HNATIVE FIRST ROW`,
      ),
    size,
  );
  const reader = page.locator('.ripple-scroll');
  const fits = () =>
    page.waitForFunction(() => {
      const el = document.querySelector('.ripple-scroll');
      return (
        el &&
        el.querySelector('.ripple-prose') &&
        getComputedStyle(el).overflowY === 'clip' &&
        el.scrollTop === 0
      );
    });
  await fits();
  const labels = reader.locator('[data-ripple-start]').filter({ hasText: /^Row \d+$/ });
  const label = labels.first();
  const number = Number((await label.innerText()).split(' ')[1]);
  assert.equal(
    Number((await labels.first().innerText()).split(' ')[1]),
    1,
    'fitting preserves the first output row',
  );
  await reader.getByText('Past prompt', { exact: true }).waitFor();
  const last = reader.getByText('LAST COVERED ROW', { exact: true });
  await last.waitFor();
  assert.ok(
    (await last.boundingBox()).y + (await last.boundingBox()).height <=
      (await reader.boundingBox()).y + (await reader.boundingBox()).height,
    'last covered row is fully visible above the divider',
  );
  const nativeFirst = page.locator('.xterm-rows > div').filter({ hasText: 'NATIVE FIRST ROW' });
  assert.ok(
    (await nativeFirst.boundingBox()).y >=
      (await reader.boundingBox()).y + (await reader.boundingBox()).height - 1,
    'first native row is fully exposed',
  );
  const point = await label.evaluate((el) => {
    const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 1);
    const box = range.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
  const inputs = () =>
    page.evaluate(() =>
      window.rippleFixture.messages.filter((m) => m.t === 'stdin').map((m) => m.data),
    );
  assert.ok(
    (await inputs()).includes(`\x1b[<0;3;${number * 2}M`),
    `fitted text clicks retain original terminal rows: ${number}, ${JSON.stringify(await inputs())}`,
  );
  await reader.hover();
  const before = (await inputs()).length;
  const unchanged = await reader.innerText();
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(100);
  assert.ok(
    (await inputs()).slice(before).some((data) => data.startsWith('\x1b[<64;')),
    'first wheel reaches CLI',
  );
  await fits();
  assert.equal(
    await reader.innerText(),
    unchanged,
    'wheel input alone never shifts the fitted window',
  );
  await page.mouse.wheel(0, 1);
  await page.waitForTimeout(100);
  assert.equal(
    await reader.innerText(),
    unchanged,
    'reversing scroll direction never reflows an unchanged CLI screen',
  );
  const geometry = await page.locator('.ripple').evaluate((el) => {
    const section = el.getBoundingClientRect();
    const grip = el.querySelector('.ripple-boundary').getBoundingClientRect();
    const line = getComputedStyle(el, '::after');
    return {
      left: parseFloat(line.left),
      right: section.right - grip.right,
      lineEnd: section.right - parseFloat(line.right),
      gripStart: grip.left,
      lineColour: line.backgroundColor,
    };
  });
  assert.equal(geometry.left, geometry.right, 'equal outer divider insets');
  assert.ok(geometry.lineEnd < geometry.gripStart, 'line stops before the grip');
  const grip = page.locator('.ripple-boundary');
  const backing = await grip.evaluate((el) => getComputedStyle(el).backgroundColor);
  await grip.hover();
  assert.notEqual(
    await grip.evaluate((el) => getComputedStyle(el).backgroundColor),
    backing,
    'hover deepens grip',
  );
  assert.equal(geometry.right, 4, 'handle sits close to the right edge');
  const assertWidth = async () => {
    const pane = await reader.boundingBox();
    for (const box of await reader.locator('.ripple-content, .ripple-user-turn').all()) {
      const bounds = await box.boundingBox();
      assert.ok(
        bounds.x >= pane.x - 1 && bounds.x + bounds.width <= pane.x + pane.width + 1,
        'scaled content and prompt bubbles remain within the pane',
      );
    }
  };
  await assertWidth();
  await page.setViewportSize({ width: 700, height: 500 });
  await fits();
  await page.setViewportSize({ width: 1100, height: 850 });
  await fits();
  await assertWidth();
  await page.screenshot({ path: '/private/tmp/puddle-ripple-fit.png' });
  const style = await reader.locator('.ripple-content').evaluate((el) => {
    const css = getComputedStyle(el);
    return [css.fontSize, css.lineHeight, css.zoom, el.getBoundingClientRect().y];
  });
  await page.evaluate(() =>
    window.rippleFixture.output('\x1b[2J\x1b[H› Short prompt\r\n\r\nShort reply'),
  );
  await reader.getByText('Short reply', { exact: true }).waitFor();
  await fits();
  assert.deepEqual(
    await reader.locator('.ripple-content').evaluate((el) => {
      const css = getComputedStyle(el);
      return [css.fontSize, css.lineHeight, css.zoom, el.getBoundingClientRect().y];
    }),
    style,
    'shorter frames retain fixed typography and top alignment',
  );
  const grid = () =>
    page.evaluate(() =>
      window.rippleFixture.messages.findLast((m) => m.t === 'resize' || m.t === 'attach'),
    );
  const reduced = await grid();
  const native = await page.locator('.xterm').elementHandle();
  await page.evaluate(() => window.rippleFixture.enable(false));
  await reader.waitFor({ state: 'detached' });
  await page.waitForTimeout(100);
  assert.equal((await grid()).rows, reduced.rows + 2, 'full CLI restores the two reserved rows');
  await page.evaluate(() => window.rippleFixture.enable(true));
  await reader.waitFor();
  await page.waitForTimeout(100);
  assert.equal((await grid()).rows, reduced.rows, 'Ripple reports two fewer rows');
  assert.ok(
    await native.evaluate((el) => el === document.querySelector('.xterm')),
    'changing row reservation keeps the terminal instance',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Ripple reserves two rows, keeps fixed top-aligned text, relays scrolling, preserves boundary rows and anchored clicks, and retains divider geometry.',
  );
} finally {
  await browser.close();
}
