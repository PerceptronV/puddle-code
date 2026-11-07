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
      Array.from({ length: 90 }, (_, n) => `\r\n\r\nParagraph ${n}. A little room to read.`).join(
        '',
      ) + '\r\n'.repeat(6),
    ),
  );
  await page.locator('.ripple-prose').filter({ hasText: 'Paragraph 89' }).waitFor();
  await reader.hover();
  await page.mouse.wheel(0, -5000);
  await page.getByRole('button', { name: 'Latest output' }).waitFor();
  const before = await page.locator('.ripple-prose').innerText();
  await page.evaluate(() => window.rippleFixture.output('\r\nLatest marker' + '\r\n'.repeat(6)));
  await page.waitForTimeout(250);
  assert.equal(
    await page.locator('.ripple-prose').innerText(),
    before,
    'scrolled reading position stays frozen',
  );
  await page.getByRole('button', { name: 'Latest output' }).click();
  await page.locator('.ripple-prose').filter({ hasText: 'Latest marker' }).waitFor();

  await page.evaluate(() => window.rippleFixture.alternateScreen());
  await page.locator('.ripple-prose').filter({ hasText: 'Agent reply' }).waitFor();
  assert.ok(!(await page.locator('.ripple-prose').innerText()).includes('Latest marker'));
  await page.locator('[data-ripple-rich="mermaid"] svg').waitFor();
  await page.locator('[data-ripple-rich="math"] .katex').waitFor();
  await reader.focus();
  await page.evaluate(() => {
    const text = document.querySelector('.ripple-text');
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  });
  const alternateSelected = await page.evaluate(() => window.getSelection().toString());
  await page.keyboard.press('ControlOrMeta+c');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), alternateSelected);
  await page.evaluate(() =>
    window.rippleFixture.output('\x1b[?2026h\x1b[2J\x1b[HReplacement frame\x1b[?2026l'),
  );
  await page.waitForTimeout(250);
  assert.equal(
    await page.evaluate(() => window.getSelection().toString()),
    alternateSelected,
    'alternate redraw preserves reader selection',
  );
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.locator('.ripple-prose').filter({ hasText: 'Replacement frame' }).waitFor();
  assert.equal(
    (await page.locator('.ripple-prose').innerText()).trim(),
    'Replacement frame',
    'alternate redraw replaces old frame and diagrams',
  );
  assert.equal(await page.locator('[data-ripple-rich]').count(), 0);
  await page.getByRole('button', { name: 'Type in CLI', exact: true }).click();
  await page.keyboard.press('Shift+ArrowLeft');
  assert.equal(
    await page.evaluate(
      () => window.rippleFixture.messages.filter((message) => message.t === 'stdin').at(-1).data,
    ),
    '\x1b[1;2D',
  );
  await page.evaluate(() => window.rippleFixture.output('\x1b[?1049l'));
  await page.locator('.ripple-prose').filter({ hasText: 'Latest marker' }).waitFor();
  assert.ok(!(await page.locator('.ripple-prose').innerText()).includes('Replacement frame'));
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
  // Reproduce enabling Ripple on a session that is already in alternate mode.
  await page.goto(new URL('/e2e/fixtures/ripple.html?alternate', page.url()).href);
  await page.locator('.ripple-prose').filter({ hasText: 'Agent reply' }).waitFor();
  await page.locator('[data-ripple-rich="mermaid"] svg').waitFor();
  await page.locator('[data-ripple-rich="math"] .katex').waitFor();
  await page.screenshot({ path: '/private/tmp/puddle-ripple-alternate.png' });
  const screen = await page.locator('.ripple-scroll').boundingBox();
  const controls = await page.locator('.ripple-native').boundingBox();
  assert.ok(
    screen.height > 100 && controls.height > 100,
    'reader and native controls both remain visible',
  );
  for (const agent of ['codex', 'claude-code', 'gemini-cli', 'opencode']) {
    for (const alternate of [false, true]) {
      const url = new URL('/e2e/fixtures/ripple.html', page.url());
      url.searchParams.set('agent', agent);
      if (alternate) url.searchParams.set('alternate', '');
      await page.goto(url.href);
      await page
        .locator('.ripple-prose')
        .filter({ hasText: alternate ? 'Agent reply' : 'What changed' })
        .waitFor();
      await page.locator('[data-ripple-rich="mermaid"] svg').waitFor();
      await page.locator('[data-ripple-rich="math"] .katex').waitFor();
      await page.getByRole('button', { name: 'Type in CLI', exact: true }).click();
      await page.keyboard.press('Shift+ArrowLeft');
      await page.keyboard.press('Shift+ArrowRight');
      const keys = await page.evaluate(() =>
        window.rippleFixture.messages
          .filter((message) => message.t === 'stdin')
          .map((message) => message.data),
      );
      assert.deepEqual(
        keys.slice(-2),
        ['\x1b[1;2D', '\x1b[1;2C'],
        `${agent} native editing in ${alternate ? 'alternate' : 'normal'} mode`,
      );
      await page.getByRole('button', { name: 'CLI only', exact: true }).click();
      await page.locator('.ripple').waitFor({ state: 'detached' });
      await page.evaluate(() => window.rippleFixture.enable(null));
      await page.locator('.ripple').waitFor();
      assert.equal(
        await page.evaluate(
          () => window.rippleFixture.messages.filter((message) => message.t === 'attach').length,
        ),
        1,
        `${agent} retains its attachment`,
      );
    }
  }
  // A remote/busy CLI may take longer than 500 ms to answer a native scroll.
  // Keep that explicit intent until the reader itself is scrolled again.
  await page.evaluate(() =>
    window.rippleFixture.output(
      '\x1b[?1049h\x1b[2J\x1b[H' +
        Array.from({ length: 35 }, (_, index) => `Paragraph ${index}\r\n\r\n`).join(''),
    ),
  );
  await page.waitForTimeout(100);
  await reader.hover();
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(100);
  await page.locator('.xterm-screen').dispatchEvent('wheel', { deltaY: -100 });
  await page.waitForTimeout(750);
  await page.evaluate(() => window.rippleFixture.output('\x1b[2J\x1b[HDelayed CLI scroll reply'));
  await page.locator('.ripple-prose').filter({ hasText: 'Delayed CLI scroll reply' }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'Ripple defaults, overrides, native keyboard/attachment, copy, selection, scroll, replay, alternate screen, rich output and themes pass.',
  );
} finally {
  await browser.close();
}
