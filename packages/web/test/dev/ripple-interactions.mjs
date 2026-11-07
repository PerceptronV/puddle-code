/* global window, document -- browser fixture */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.openedUrls = [];
    window.open = (uri) => {
      window.openedUrls.push(uri);
      return null;
    };
  });
  await page.goto(
    new URL(
      '/e2e/fixtures/ripple.html?live&ripple',
      process.env.PREVIEW_URL ?? 'http://127.0.0.1:5174/',
    ).href,
  );
  await page.waitForFunction(() => window.rippleFixture?.messages.some((m) => m.t === 'attach'));
  const size = await page.evaluate(() =>
    window.rippleFixture.messages.findLast((m) => m.t === 'attach' || m.t === 'resize'),
  );
  const url = 'http://localhost:5174/e2e/fixtures/ripple.html?ripple';
  const lines = [
    '› - First point',
    '  - Second point',
    '    wrapped continuation',
    '  ',
    '  Final paragraph',
    '',
    '• Answer',
    `open '\x1b[31m${url.slice(0, -4)}\x1b[1;34m${url.slice(-4)}\x1b[0m'`,
    `\x1b[32m[local preview](${url})\x1b[0m`,
    'git push https://github.com/PerceptronV/puddle-code.git',
    'Read src/example.ts:12:3 and /outside/notes.md:7',
    'Missing src/missing.ts',
    '',
    '  + Show details'.padEnd(size.cols - 1),
  ];
  await page.evaluate(
    (data) => window.rippleFixture.output(data),
    '\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[H' +
      lines.join('\r\n') +
      `\x1b[${size.rows - 3};1H› Native input\x1b[${size.rows - 2};1HStatus`,
  );
  const reader = page.locator('.ripple-prose');
  await reader.getByText('Final paragraph', { exact: true }).waitFor();
  const bubble = page.locator('.ripple-user-turn');
  assert.ok((await bubble.innerText()).includes('Second point'));
  assert.ok((await bubble.innerText()).includes('Final paragraph'));
  assert.ok(!(await bubble.innerText()).includes('Answer'));
  await reader.locator('[data-ripple-kind="url"]').first().click();
  assert.equal((await page.evaluate(() => window.openedUrls)).at(-1), url);
  const markdown = reader.locator('a').filter({ hasText: 'local preview' });
  assert.equal(await markdown.getAttribute('href'), url);
  await markdown.click({ modifiers: ['Meta'] });
  assert.equal((await page.evaluate(() => window.openedUrls)).at(-1), url);
  await reader
    .locator('[data-ripple-kind="url"]')
    .filter({ hasText: 'https://github.com/PerceptronV/puddle-code.git' })
    .click();
  assert.equal(
    (await page.evaluate(() => window.openedUrls)).at(-1),
    'https://github.com/PerceptronV/puddle-code.git',
  );
  const file = reader
    .locator('[data-ripple-kind="file"]')
    .filter({ hasText: 'src/example.ts:12:3' });
  await file.hover();
  await page.waitForFunction(() => document.querySelector('[data-valid-file="true"]'));
  await file.click();
  assert.equal(await page.evaluate(() => window.rippleFixture.openedFiles.length), 0);
  await file.click({ modifiers: ['Meta'] });
  await page.waitForFunction(() => window.rippleFixture.openedFiles.length === 1);
  assert.deepEqual(await page.evaluate(() => window.rippleFixture.openedFiles[0]), {
    kind: 'file',
    path: 'src/example.ts',
    line: 12,
    column: 3,
  });
  await reader
    .locator('[data-ripple-kind="file"]')
    .filter({ hasText: '/outside/notes.md:7' })
    .click({ modifiers: ['Meta'] });
  await page.waitForFunction(() => window.rippleFixture.openedFiles.length === 2);
  assert.deepEqual(await page.evaluate(() => window.rippleFixture.openedFiles[1]), {
    kind: 'file',
    path: 'notes.md',
    root: '/outside',
    line: 7,
  });
  await reader
    .locator('[data-ripple-kind="file"]')
    .filter({ hasText: 'src/missing.ts' })
    .click({ modifiers: ['Meta'] });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.rippleFixture.openedFiles.length), 2);
  const details = reader.getByRole('button', { name: '+ Show details' });
  const before = await page.evaluate(
    () => window.rippleFixture.messages.filter((m) => m.t === 'stdin').length,
  );
  await details.click();
  const input = await page.evaluate(() =>
    window.rippleFixture.messages
      .filter((m) => m.t === 'stdin')
      .slice(-2)
      .map((m) => m.data),
  );
  assert.deepEqual(input, ['\x1b[<0;3;14M', '\x1b[<0;3;14m']);
  assert.equal(
    await page.evaluate(() => window.rippleFixture.messages.filter((m) => m.t === 'stdin').length),
    before + 2,
  );
  // Keep a selected reading snapshot while its native control is replaced.
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('.ripple-user-turn'));
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    window.rippleFixture.output('\x1b[14;1H\x1b[2K  A different screen');
  });
  await page.waitForTimeout(100);
  await details.click();
  assert.equal(
    await page.evaluate(() => window.rippleFixture.messages.filter((m) => m.t === 'stdin').length),
    before + 2,
    'stale click does not reach the replacement screen',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Ripple URL destinations, native URL/path opening, multiline prompts, disclosure mouse events and stale-click checks pass.',
  );
} finally {
  await browser.close();
}
