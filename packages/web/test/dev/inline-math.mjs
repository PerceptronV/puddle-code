/* global window, document, getComputedStyle, navigator -- browser fixtures */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch();
try {
  const base = process.env.PREVIEW_URL ?? 'http://127.0.0.1:5174/';
  for (const surface of ['terminal', 'ripple']) {
    const page = await browser.newPage({
      viewport: { width: 1300, height: 1000 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(
      new URL(
        surface === 'terminal'
          ? '/e2e/fixtures/ripple.html?live'
          : '/e2e/fixtures/ripple.html?ripple',
        base,
      ).href,
    );
    if (surface === 'terminal') {
      await page.waitForFunction(() =>
        window.rippleFixture?.messages.some((m) => m.t === 'attach'),
      );
      await page.evaluate(() =>
        window.rippleFixture.output('\x1b[?1000h\x1b[?1006hBefore $E=mc^2$ after.\r\n'),
      );
    }
    const selector =
      surface === 'terminal'
        ? '[data-terminal-rich-block].inline-math-toggle'
        : '.ripple [data-ripple-rich].inline-math-toggle';
    const formula = page.locator(selector).first();
    await formula.locator('.katex').waitFor();
    assert.equal(
      await formula.getAttribute('aria-pressed'),
      'false',
      `${surface} defaults to preview`,
    );
    assert.equal(await formula.locator('button, svg').count(), 0, 'no overlaid eye/code control');
    assert.equal(
      await formula.evaluate((element) => getComputedStyle(element).borderBottomStyle),
      'dotted',
    );
    const inputs = () =>
      page.evaluate(() => window.rippleFixture.messages.filter((m) => m.t === 'stdin').length);
    const before = await inputs();
    await formula.click();
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.getAttribute('aria-pressed') === 'true',
      selector,
    );
    assert.ok((await formula.innerText()).includes('E'));
    if (surface === 'terminal') assert.equal(await formula.getAttribute('data-rendered'), 'false');
    else assert.equal(await formula.locator('.katex:visible').count(), 0);
    await formula.focus();
    await page.keyboard.press('Enter');
    await formula.locator('.katex:visible').waitFor();
    assert.equal(await formula.getAttribute('aria-pressed'), 'false');
    await page.keyboard.press('Space');
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.getAttribute('aria-pressed') === 'true',
      selector,
    );
    // Selecting source is a browser action and must not flip back or reach the CLI.
    await formula.scrollIntoViewIfNeeded();
    const rect = await formula.boundingBox();
    await page.mouse.move(rect.x + 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width - 2, rect.y + rect.height / 2, { steps: 8 });
    await page.mouse.up();
    assert.equal(await formula.getAttribute('aria-pressed'), 'true');
    assert.ok(
      await page.evaluate(() => window.getSelection().toString().length > 0),
      `${surface} source is selectable`,
    );
    const selected = await page.evaluate(() => window.getSelection().toString());
    await page.keyboard.press('ControlOrMeta+c');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), selected);
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await formula.click();
    await formula.locator('.katex:visible').waitFor();
    assert.equal(await inputs(), before, 'toggle gestures do not become terminal input');
    assert.deepEqual(errors, []);
    await page.close();
  }

  console.log(
    'Terminal and Ripple inline maths default to preview, underline directly, toggle on click/keyboard and retain source selection without CLI input.',
  );
} finally {
  await browser.close();
}
