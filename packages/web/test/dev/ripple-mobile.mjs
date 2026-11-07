/* global window, document, getComputedStyle -- browser fixture */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    new URL(
      '/e2e/fixtures/ripple.html?mobile&live',
      process.env.PREVIEW_URL ?? 'http://127.0.0.1:5174/',
    ).href,
  );
  await page.waitForFunction(() => window.rippleFixture?.messages.some((m) => m.t === 'attach'));
  const boundary = page.getByRole('separator', { name: 'Native CLI boundary' });
  await boundary.waitFor();
  const native = await page.locator('.xterm').elementHandle();
  const handle = await boundary.boundingBox();
  assert.ok(handle.width >= 44 && handle.height >= 44, 'touch-sized divider');
  const phonePane = await page.locator('.phone-terminal').boundingBox();
  assert.equal(
    handle.x + handle.width,
    phonePane.x + phonePane.width,
    'handle reaches the phone pane edge',
  );
  assert.equal(await boundary.evaluate((el) => getComputedStyle(el).right), '-4px');
  assert.equal(await page.locator('.ripple-scroll').count(), 0, 'full CLI remains the default');
  const touch = await page.context().newCDPSession(page);
  const drag = async (from, to) => {
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ ...from, id: 1 }],
    });
    for (let step = 1; step <= 12; step++) {
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          {
            x: from.x + ((to.x - from.x) * step) / 12,
            y: from.y + ((to.y - from.y) * step) / 12,
            id: 1,
          },
        ],
      });
      await page.waitForTimeout(16);
    }
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const dragBoundary = async (edge) => {
    const grip = await boundary.boundingBox();
    const pane = await page.locator('.puddle-terminal').boundingBox();
    await drag(
      { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 },
      { x: grip.x + grip.width / 2, y: edge === 'top' ? pane.y + 1 : pane.y + pane.height - 1 },
    );
  };
  await page.evaluate(() => {
    const { rows } = window.rippleFixture.messages.findLast(
      (m) => m.t === 'resize' || m.t === 'attach',
    );
    window.rippleFixture.output(
      '\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[H' +
        [
          '› Read this on my phone',
          '',
          '\x1b[1m• Mobile reply\x1b[0m',
          'Math: $E=mc^2$.',
          '',
          'flowchart LR',
          'A --> B',
          '',
          ...Array.from({ length: 1 }, (_, i) => `Paragraph ${i} for reading.`),
        ].join('\r\n') +
        `\x1b[${rows - 3};1H› Ask Codex to do anything\x1b[${rows - 1};1HFooter\x1b[${rows - 3};3H`,
    );
  });
  await dragBoundary('bottom');
  await page.locator('.ripple-scroll').waitFor();
  await page.waitForFunction(
    () => document.querySelector('.ripple-boundary').getAttribute('aria-valuenow') === '0',
  );
  await page.locator('.ripple [data-ripple-rich="math"] .katex').waitFor();
  await page.locator('.ripple [data-ripple-rich="mermaid"] svg').waitFor();
  assert.ok(
    await native.evaluate((el) => el === document.querySelector('.xterm')),
    'touch drag retains the native terminal',
  );
  assert.equal(
    await page.evaluate(() => window.rippleFixture.messages.filter((m) => m.t === 'attach').length),
    1,
  );
  const reader = page.locator('.ripple-scroll');
  await reader.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({ path: '/private/tmp/puddle-ripple-mobile.png' });
  const input = () =>
    page.evaluate(() =>
      window.rippleFixture.messages.filter((m) => m.t === 'stdin').map((m) => m.data),
    );
  const swipe = async (direction) => {
    const box = await reader.boundingBox();
    await drag(
      { x: box.x + box.width / 2, y: box.y + box.height * (direction === 'down' ? 0.3 : 0.7) },
      { x: box.x + box.width / 2, y: box.y + box.height * (direction === 'down' ? 0.7 : 0.3) },
    );
  };
  // Dense output must fit, and the very first swipe must reach the CLI.
  await page.evaluate(() => {
    const { rows } = window.rippleFixture.messages.findLast(
      (m) => m.t === 'resize' || m.t === 'attach',
    );
    window.rippleFixture.output(
      '\x1b[2J\x1b[H' +
        Array.from({ length: rows - 4 }, (_, i) => `• Reply ${i}\r\n`).join('') +
        `\x1b[${rows - 2};1H› Ask Codex to do anything`,
    );
  });
  await page.waitForTimeout(200);
  assert.ok(
    await reader.evaluate((el) => getComputedStyle(el).overflowY === 'clip'),
    'reader has no independent vertical scroll',
  );
  const before = (await input()).length;
  await swipe('down');
  assert.ok((await input()).slice(before).some((data) => data.startsWith('\x1b[<64;')));
  await page.evaluate(() => window.rippleFixture.output('\x1b[2J\x1b[H• Earlier mobile reply'));
  await reader.getByText('Earlier mobile reply', { exact: true }).waitFor();
  await swipe('up');
  assert.ok((await input()).slice(before).some((data) => data.startsWith('\x1b[<65;')));
  assert.equal(await reader.evaluate((el) => el.scrollTop), 0);
  assert.ok(
    (await input())
      .slice(before)
      .every((data) => data.startsWith('\x1b[<64;') || data.startsWith('\x1b[<65;')),
    'swipes never click terminal cells',
  );
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  // Native phone keys remain available below a fully expanded reading view.
  await page.getByRole('button', { name: 'Esc', exact: true }).tap();
  assert.equal((await input()).at(-1), '\x1b');
  await page.setViewportSize({ width: 320, height: 540 });
  await page.waitForTimeout(200);
  assert.equal(
    await boundary.getAttribute('aria-valuenow'),
    '0',
    'keyboard-sized viewport keeps bottom anchor',
  );
  assert.ok(await page.locator('.phone-composer').isVisible());
  assert.ok(
    await page.locator('.phone-terminal').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  );
  await dragBoundary('top');
  await reader.waitFor({ state: 'detached' });
  await page.reload();
  await boundary.waitFor();
  assert.equal(await page.locator('.ripple-scroll').count(), 0, 'top anchor survives reload');
  await page.getByRole('button', { name: 'Appearance', exact: true }).tap();
  await page.locator('#ripple-enabled').tap();
  await page.getByRole('button', { name: 'Appearance', exact: true }).tap();
  await reader.waitFor();
  assert.ok(
    Number(await boundary.getAttribute('aria-valuenow')) > 0,
    'appearance setting restores native input space',
  );
  assert.deepEqual(errors, []);
  await touch.detach();
  console.log(
    'Mobile Ripple touch divider, rich rendering, fitted rows, immediate native history relay, phone keys and resized/reloaded boundaries pass.',
  );
} finally {
  await browser.close();
}
