/* global window, document -- browser fixture */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    new URL(
      '/e2e/fixtures/ripple.html?live&ripple',
      process.env.PREVIEW_URL ?? 'http://127.0.0.1:5174/',
    ).href,
  );
  await page.waitForFunction(() => window.rippleFixture?.messages.some((m) => m.t === 'attach'));
  let manual = false;
  const frame = async (extra = 0, spinner = '•') => {
    await page.evaluate(
      ({ extra, spinner }) => {
        const { rows } = window.rippleFixture.messages.findLast(
          (m) => m.t === 'attach' || m.t === 'resize',
        );
        const composer = rows - 4 - extra;
        window.rippleFixture.output(
          '\x1b[?1049h\x1b[2J\x1b[H› Short pinned prompt\r\n• Exited (status 1) python3\r\n  └ }\r\n\r\n    Node.js v22.21.1\r\n  + 127 lines (⌃t to expand)' +
            `\x1b[${composer - 4};1H${spinner} Working (9s • esc to interrupt)` +
            `\x1b[${composer - 3};1H  Tip: Native controls` +
            `\x1b[${composer};1H› Draft` +
            '\r\n  Continued input'.repeat(extra) +
            `\x1b[${rows - 1};1HStatus\x1b[${rows - 4};7H`,
        );
      },
      { extra, spinner },
    );
    await page.waitForFunction(
      ({ extra, spinner, manual }) => {
        const rows = [...document.querySelectorAll('.xterm-rows > div')];
        return (
          rows.filter((row) => row.textContent.includes('Continued input')).length === extra &&
          rows.some(
            (row) => row.textContent.trim() === `${spinner} Working (9s • esc to interrupt)`.trim(),
          ) &&
          (!manual ||
            (document.querySelector('.ripple-boundary')?.getAttribute('aria-valuenow') ===
              String(7 + extra) &&
              [...document.querySelectorAll('.ripple-prose pre')].some(
                (row) =>
                  row.textContent.trim() === `${spinner} Working (9s • esc to interrupt)`.trim(),
              )))
        );
      },
      { extra, spinner, manual },
    );
  };
  await frame();
  const boundary = page.getByRole('separator', { name: 'Native CLI boundary' });
  await boundary.waitFor();
  const automatic = Number(await boundary.getAttribute('aria-valuenow'));
  // Place it beside the input. Working is now intentionally in the reader.
  await boundary.focus();
  for (let i = automatic; i > 7; i--) {
    await boundary.focus();
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);
  }
  assert.equal(await boundary.getAttribute('aria-valuenow'), '7');
  manual = true;
  const working = page.locator('.ripple-prose pre').filter({ hasText: 'Working' });
  const initial = await working.boundingBox();
  for (const spinner of ['◦', '·', '...', '⠋', '', '•']) {
    await frame(0, spinner);
    assert.deepEqual(await working.boundingBox(), initial, `stable layout for ${spinner}`);
    assert.equal(await boundary.getAttribute('aria-valuenow'), '7');
  }
  for (const extra of [4, 12, 0]) {
    await frame(extra);
    assert.equal(Number(await boundary.getAttribute('aria-valuenow')), 7 + extra);
    assert.ok(!(await page.locator('.ripple-prose').innerText()).includes('Continued input'));
  }
  await page.reload();
  await page.waitForFunction(() => window.rippleFixture?.messages.some((m) => m.t === 'attach'));
  await frame(3);
  assert.equal(Number(await boundary.getAttribute('aria-valuenow')), 10, 'input anchor persists');
  await page.setViewportSize({ width: 950, height: 750 });
  await page.waitForTimeout(150);
  await frame(5);
  assert.equal(
    Number(await boundary.getAttribute('aria-valuenow')),
    12,
    'input anchor survives resize',
  );
  // Both extremes remain reachable without resizing/replacing the native terminal.
  const native = await page.locator('.xterm').elementHandle();
  const attachCount = await page.evaluate(
    () => window.rippleFixture.messages.filter((m) => m.t === 'attach').length,
  );
  const dragTo = async (edge) => {
    const handle = await boundary.boundingBox();
    const pane = await page.locator('.puddle-terminal').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      handle.x + handle.width / 2,
      edge === 'top' ? pane.y + 1 : pane.y + pane.height - 1,
      { steps: 12 },
    );
    await page.mouse.up();
  };
  await dragTo('top');
  await page.locator('.ripple-scroll').waitFor({ state: 'detached' });
  assert.equal(
    await boundary.getAttribute('aria-valuenow'),
    await boundary.getAttribute('aria-valuemax'),
  );
  await page.setViewportSize({ width: 1100, height: 950 });
  await page.waitForTimeout(150);
  assert.equal(
    await boundary.getAttribute('aria-valuenow'),
    await boundary.getAttribute('aria-valuemax'),
  );
  await dragTo('bottom');
  await page.waitForFunction(
    () => document.querySelector('.ripple-boundary')?.getAttribute('aria-valuenow') === '0',
  );
  assert.equal(
    (await page.locator('.ripple').boundingBox()).height,
    (await page.locator('.puddle-terminal').boundingBox()).height,
  );
  assert.ok(await native.evaluate((el) => el === document.querySelector('.xterm')));
  assert.equal(
    await page.evaluate(() => window.rippleFixture.messages.filter((m) => m.t === 'attach').length),
    attachCount,
  );
  await page.reload();
  await boundary.waitFor();
  await page.waitForFunction(
    () => document.querySelector('.ripple-boundary')?.getAttribute('aria-valuenow') === '0',
  );
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const order = await page
    .locator('[id="ripple-enabled"], [id="reduce-motion"]')
    .evaluateAll((els) => els.map((el) => el.id));
  assert.deepEqual(order, ['ripple-enabled', 'reduce-motion']);
  await page.locator('#ripple-enabled').click();
  await page.locator('.ripple-scroll').waitFor({ state: 'detached' });
  await page.locator('#ripple-enabled').click();
  await page.locator('.ripple-scroll').waitFor();
  assert.ok(
    Number(await boundary.getAttribute('aria-valuenow')) > 0,
    'enabling restores automatic input placement',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Ripple working animation stays stable; nearby boundaries follow growing/shrinking drafts across reload and resize.',
  );
} finally {
  await browser.close();
}
