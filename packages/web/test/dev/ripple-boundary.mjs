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
          '\x1b[?1049h\x1b[2J\x1b[H› Short pinned prompt\r\n  115 - old code\r\n  115 + new code' +
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
  assert.deepEqual(errors, []);
  console.log(
    'Ripple working animation stays stable; nearby boundaries follow growing/shrinking drafts across reload and resize.',
  );
} finally {
  await browser.close();
}
