/* global window, document, navigator -- browser fixture */
// Opt-in real Codex check. Never launches puddled. RIPPLE_CODEX_CWD resumes only
// a previously created test directory; otherwise a harmless fresh turn is used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
const require = createRequire(new URL('../../../daemon/package.json', import.meta.url));
const pty = require('node-pty');
const cwd = process.env.RIPPLE_CODEX_CWD ?? mkdtempSync(`${tmpdir()}/ripple-live-`);
const prompt =
  'Do not call tools or read files. This is a UI rendering test. Reply with a Markdown heading "Ripple live verification", bold and italic words, a bullet list, a short fenced TypeScript code block, inline LaTeX $E=mc^2$, and a fenced Mermaid flowchart A --> B. Then write twelve numbered sections of two sentences each about fictional gardens so the reply is long enough to scroll. End with "RIPPLE LIVE END".';
const browser = await chromium.launch({ headless: true });
let proc;
let stopped = false;
let pump;
try {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    new URL('/e2e/fixtures/ripple.html?live', process.env.PREVIEW_URL ?? 'http://127.0.0.1:5174/')
      .href,
  );
  await page.locator('.xterm').waitFor();
  await page.waitForFunction(() => window.rippleFixture.messages.some((m) => m.t === 'attach'));
  const size = await page.evaluate(() =>
    window.rippleFixture.messages.findLast((m) => m.t === 'resize' || m.t === 'attach'),
  );
  const args = process.env.RIPPLE_CODEX_CWD ? ['resume', '--last'] : [];
  args.push('--no-daemon', '-C', cwd, '-s', 'read-only', '-a', 'never');
  if (!process.env.RIPPLE_CODEX_CWD) args.push(prompt);
  proc = pty.spawn(process.env.CODEX_BINARY ?? 'codex', args, {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NO_COLOR')),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
  });
  let pending = '';
  let index = 0;
  proc.onData((data) => {
    pending += data;
  });
  pump = (async () => {
    while (!stopped) {
      const messages = await page.evaluate(() => window.rippleFixture.messages);
      for (const message of messages.slice(index)) {
        if (message.t === 'stdin') proc.write(message.data);
        if (message.t === 'resize') proc.resize(message.cols, message.rows);
      }
      index = messages.length;
      if (pending) {
        const chunk = pending;
        pending = '';
        await page.evaluate((data) => window.rippleFixture.output(data), chunk);
      }
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  })();
  // Observe an actual reply row, not the same words in the submitted prompt.
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.xterm-rows > div')].some(
        (row) => row.textContent.trim() === 'RIPPLE LIVE END',
      ),
    undefined,
    { timeout: 120000 },
  );
  const before = await page.locator('.xterm-screen').boundingBox();
  await page.evaluate(() => window.rippleFixture.enable(true));
  await page.locator('.ripple-prose').filter({ hasText: 'RIPPLE LIVE END' }).waitFor();
  assert.deepEqual(
    await page.locator('.xterm-screen').boundingBox(),
    before,
    'overlay keeps the real PTY geometry',
  );
  assert.ok(
    !(await page.locator('.ripple-prose').innerText()).includes('Ask Codex to do anything'),
    'composer remains native',
  );
  const summary = page.locator('[data-ripple-summary]');
  await summary.waitFor();
  const pinnedScreen = await page.locator('.xterm-rows').innerText();
  await summary.click();
  await page.waitForFunction(
    (previous) => document.querySelector('.xterm-rows').innerText !== previous,
    pinnedScreen,
  );
  assert.ok(
    (await page.locator('.xterm-rows').innerText()).includes('Then write twelve numbered sections'),
    'anchored summary click restores the original multiline prompt',
  );
  const reader = page.locator('.ripple-scroll');
  await reader.hover();
  for (
    let i = 0;
    i < 45 &&
    !(await page.getByRole('heading', { name: 'Ripple live verification', exact: true }).count());
    i++
  ) {
    await page.mouse.wheel(0, -1000);
    await page.waitForTimeout(100);
  }
  await page.getByRole('heading', { name: 'Ripple live verification', exact: true }).waitFor();
  assert.ok(await page.locator('.ripple-user-turn').count(), 'Codex prompt bubble');
  assert.ok(await page.locator('.ripple-prose [style*="font-weight"]').count(), 'real ANSI bold');
  assert.ok(
    await page.locator('.ripple-prose [style*="font-style:italic"]').count(),
    'real ANSI italic',
  );
  assert.ok(await page.locator('.ripple-prose [style*="color:"]').count(), 'real ANSI colours');
  assert.equal(
    await page.locator('.ripple-prose br').count(),
    0,
    'prose reflows without terminal hard breaks',
  );
  await page.screenshot({ path: '/private/tmp/puddle-ripple-live-codex.png' });
  await reader.focus();
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('.ripple-user-turn'));
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  });
  const copied = await page.evaluate(() => window.getSelection().toString());
  await page.keyboard.press('ControlOrMeta+c');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), copied);
  await page.evaluate(() => window.getSelection().removeAllRanges());
  const boundary = page.getByRole('separator', { name: 'Native CLI boundary' });
  const rows = Number(await boundary.getAttribute('aria-valuenow'));
  const handle = await boundary.boundingBox();
  const cellHeight = before.height / size.rows;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 - 3 * cellHeight);
  await page.mouse.up();
  await page.waitForTimeout(100);
  assert.equal(Number(await boundary.getAttribute('aria-valuenow')), rows + 3);
  const overlay = await page.locator('.ripple').boundingBox();
  const oldProjection = await page.locator('.ripple-prose').innerText();
  await page.mouse.move(overlay.x + 100, overlay.y + overlay.height + 12);
  await page.mouse.wheel(0, 700);
  await page.waitForFunction(
    (previous) => document.querySelector('.ripple-prose').innerText !== previous,
    oldProjection,
  );
  await page.setViewportSize({ width: 1150, height: 800 });
  await page.waitForTimeout(300);
  assert.equal(
    Number(await boundary.getAttribute('aria-valuenow')),
    rows + 3,
    'boundary anchored by rows through resize',
  );
  await page.evaluate(() => window.rippleFixture.enable(false));
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => !document.querySelector('.xterm-rows').textContent.includes('Back to bottom'),
  );
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('ripple-draft');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowRight');
  await page.waitForFunction(() =>
    document.querySelector('.xterm-rows').textContent.includes('ripple-draft'),
  );
  await page.keyboard.press('Control+u');
  await page.evaluate(() => window.rippleFixture.enable(true));
  await page.locator('.ripple').waitFor();
  await boundary.focus();
  await page.keyboard.press('Home');
  await page.waitForTimeout(150);
  await boundary.focus();
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(150);
  const compactRows = Number(await boundary.getAttribute('aria-valuenow'));
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('ripple-long-draft '.repeat(40));
  await page.waitForFunction(
    (rows) =>
      Number(document.querySelector('.ripple-boundary').getAttribute('aria-valuenow')) > rows,
    compactRows,
  );
  assert.ok(!(await page.locator('.ripple-prose').innerText()).includes('ripple-long-draft'));
  await page.keyboard.press('Control+u');
  await page.waitForFunction(
    (rows) =>
      Number(document.querySelector('.ripple-boundary').getAttribute('aria-valuenow')) === rows,
    compactRows,
  );
  await page.evaluate(() => window.rippleFixture.enable(false));
  await page.locator('.xterm').hover();
  await page.mouse.wheel(0, -700);
  await page.waitForTimeout(200);
  await page.evaluate(() => window.rippleFixture.enable(true));
  await page.locator('.ripple').waitFor();
  await page.screenshot({ path: '/private/tmp/puddle-ripple-live-resized.png' });
  assert.deepEqual(errors, []);
  console.log(
    `Real Codex overlay, ANSI styling, prompt bubble and anchored summary click, wheel relay, native typing and row-boundary resize checks pass. Test directory: ${cwd}`,
  );
} finally {
  stopped = true;
  await pump?.catch(() => {});
  proc?.kill();
  await browser.close();
}
