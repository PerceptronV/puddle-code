/* global window, document, getComputedStyle, NodeFilter -- browser fixture */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    new URL(
      '/e2e/fixtures/ripple.html?live&ripple',
      process.env.PREVIEW_URL ?? 'http://127.0.0.1:5174/',
    ).href,
  );
  await page.waitForFunction(() => window.rippleFixture?.messages.some((m) => m.t === 'attach'));
  const boundary = page.getByRole('separator', { name: 'Native CLI boundary' });
  const rows = Number(await boundary.getAttribute('aria-valuemax'));
  await page.evaluate(
    ({ rows }) =>
      window.rippleFixture.output(
        '\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[H' +
          [
            '› Keep the reading view top aligned',
            '',
            '• Viewed image screenshot.png',
            '  + Show details',
            '',
            '• Ran checking command',
            '  └ Checking formatting...',
            '    All matched files use Prettier code style!',
            '  + Show details',
          ].join('\r\n') +
          `\x1b[${rows};1HFooter`,
      ),
    { rows },
  );
  await page.getByText('Keep the reading view top aligned', { exact: true }).waitFor();
  await boundary.focus();
  while (Number(await boundary.getAttribute('aria-valuenow')) < rows - 6)
    await page.keyboard.press('ArrowUp');
  const reader = page.locator('.ripple-scroll');
  const assertVisible = async (text) => {
    const target = reader.getByText(text, { exact: true });
    await target.waitFor();
    const box = await target.boundingBox();
    const pane = await reader.boundingBox();
    assert.ok(
      box && box.y >= pane.y && box.y + box.height <= pane.y + pane.height + 1,
      `${text} is visible above the boundary: ${JSON.stringify({ box, pane })}`,
    );
  };
  for (const text of [
    'Ran checking command',
    '└ Checking formatting...',
    'All matched files use Prettier code style!',
  ]) {
    await assertVisible('Keep the reading view top aligned');
    await assertVisible(text);
    assert.equal(await reader.evaluate((el) => el.scrollTop), 0);
    assert.equal(
      await reader.locator('.ripple-content').evaluate((el) => getComputedStyle(el).zoom),
      '1',
    );
    if (text === 'Ran checking command') {
      const point = await reader.getByText(text, { exact: true }).evaluate((el) => {
        const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, 1);
        const box = range.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      });
      await page.mouse.click(point.x, point.y);
      assert.ok(
        await page.evaluate(() =>
          window.rippleFixture.messages.some((m) => m.t === 'stdin' && m.data === '\x1b[<0;3;6M'),
        ),
        'omitting older blocks preserves native cell anchors',
      );
      await boundary.focus();
    }
    await page.keyboard.press('ArrowDown');
  }
  await page.screenshot({ path: '/private/tmp/puddle-ripple-seam.png' });
  await boundary.press('Home');
  await reader.getByText('Viewed image', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'Ripple keeps pinned prompts and each tool-output boundary row visible at successive divider positions without scaling or scrolling.',
  );
} finally {
  await browser.close();
}
