/* global window, document, navigator, getComputedStyle -- browser fixture */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 850 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    new URL('/e2e/fixtures/ripple.html', process.env.PREVIEW_URL ?? 'http://127.0.0.1:5174/').href,
  );
  const native = page.locator('.xterm');
  await native.waitFor();
  const nativeHandle = await native.elementHandle();
  assert.equal(await page.locator('.ripple').count(), 0, 'Ripple defaults off');

  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.locator('#ripple-enabled').click();
  await page.locator('.ripple').waitFor();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.locator('[data-ripple-rich="mermaid"] svg').waitFor();
  await page.locator('[data-ripple-rich="math"] .katex').waitFor();
  assert.equal(await page.locator('.ripple button[aria-label="Show terminal source"]').count(), 0);
  assert.ok(
    await nativeHandle.evaluate((element) => element === document.querySelector('.xterm')),
    'enabling keeps the native terminal',
  );
  assert.equal(
    await page.evaluate(
      () => window.rippleFixture.messages.filter((message) => message.t === 'attach').length,
    ),
    1,
  );

  // Real keyboard events still travel through xterm's input channel unchanged.
  await page.getByRole('button', { name: 'Type in CLI', exact: true }).click();
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowRight');
  const input = await page.evaluate(() =>
    window.rippleFixture.messages
      .filter((message) => message.t === 'stdin')
      .map((message) => message.data),
  );
  assert.ok(input.includes('\x1b[1;2D'), 'Shift+Left keeps its native escape sequence');
  assert.ok(input.includes('\x1b[1;2C'), 'Shift+Right keeps its native escape sequence');

  const reader = page.locator('.ripple-scroll');
  await reader.focus();
  await page.evaluate(() => {
    const text = [...document.querySelectorAll('.ripple-text p')].find((node) =>
      node.textContent.includes('Read at your own pace'),
    );
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  });
  const selected = await page.evaluate(() => window.getSelection().toString());
  await page.keyboard.press('ControlOrMeta+c');
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    selected,
    'reader copy uses browser selection',
  );
  await page.evaluate(() => window.rippleFixture.output('\r\nNew output while selecting'));
  await page.waitForTimeout(250);
  assert.equal(
    await page.evaluate(() => window.getSelection().toString()),
    selected,
    'output preserves selected text',
  );
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.getByText('New output while selecting', { exact: false }).first().waitFor();

  await page.evaluate(() =>
    window.rippleFixture.output(
      Array.from({ length: 90 }, (_, n) => `\r\nParagraph ${n}. A little room to read.`).join(''),
    ),
  );
  await page.locator('.ripple-prose').filter({ hasText: 'Paragraph 89' }).waitFor();
  await reader.hover();
  await page.mouse.wheel(0, -5000);
  await page.getByRole('button', { name: 'Latest output' }).waitFor();
  const before = await page.locator('.ripple-prose').innerText();
  await page.evaluate(() => window.rippleFixture.output('\r\nLatest marker'));
  await page.waitForTimeout(250);
  assert.equal(
    await page.locator('.ripple-prose').innerText(),
    before,
    'scrolled reading position stays frozen',
  );
  await page.getByRole('button', { name: 'Latest output' }).click();
  await page.locator('.ripple-prose').filter({ hasText: 'Latest marker' }).waitFor();

  await page.evaluate(() => window.rippleFixture.output('\x1b[?1049hFull-screen menu'));
  await page.getByText('This full-screen CLI needs the native terminal.').waitFor();
  assert.equal(await reader.count(), 0);
  await page.evaluate(() => window.rippleFixture.output('\x1b[?1049l'));
  await reader.waitFor();
  await page.evaluate(() => window.rippleFixture.output('Replacement replay', true));
  await page.locator('.ripple-prose').filter({ hasText: 'Replacement replay' }).waitFor();
  assert.ok(
    !(await page.locator('.ripple-prose').innerText()).includes('Latest marker'),
    'replay replaces rather than duplicates output',
  );

  await page.getByRole('button', { name: 'CLI only', exact: true }).click();
  await page.locator('.ripple').waitFor({ state: 'detached' });
  assert.ok(
    await nativeHandle.evaluate((element) => element === document.querySelector('.xterm')),
    'disabling keeps native terminal',
  );
  await page
    .getByRole('button', { name: 'Sample agent · right-click for renderer' })
    .click({ button: 'right' });
  assert.deepEqual(
    (await page.getByRole('menuitem').allTextContents()).map((text) => text.trim()),
    [
      'Rename',
      'Kill',
      'Archive',
      'Renderer',
      'Clear captured env',
      'Open terminal in worktree',
      'Open in VS Code',
      'Open in Cursor',
    ],
  );
  await page.getByRole('menuitem', { name: 'Renderer', exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Use appearance default', exact: true }).click();
  await page.locator('.ripple').waitFor();
  await page.getByRole('button', { name: 'Switch shell', exact: true }).click();
  await page.locator('.ripple').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Switch shell', exact: true }).click();
  await page.locator('[data-ripple-rich="mermaid"] svg').waitFor();
  await page.evaluate(() => window.rippleFixture.theme('dark'));
  await page.locator('[data-ripple-rich="mermaid"] svg').waitFor();
  await page.screenshot({ path: '/private/tmp/puddle-ripple-dark.png' });
  await page.evaluate(() => window.rippleFixture.theme('light'));
  await page.locator('[data-ripple-rich="mermaid"] svg').waitFor();
  await page.screenshot({ path: '/private/tmp/puddle-ripple-light.png' });
  const fonts = await page.evaluate(() => [
    getComputedStyle(document.querySelector('.ripple-content')).fontFamily,
    getComputedStyle(document.querySelector('.ripple-prose code')).fontFamily,
  ]);
  assert.notEqual(fonts[0], fonts[1]);
  assert.deepEqual(errors, []);
  console.log(
    'Ripple defaults, overrides, native keyboard/attachment, copy, selection, scroll, replay, alternate screen, rich output and themes pass.',
  );
} finally {
  await browser.close();
}
