/* global window, document -- browser fixture */
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
  await page.evaluate(() => window.rippleFixture.enable(true));
  await page.locator('.ripple-scroll').waitFor();
  await page.locator('.ripple-input').waitFor();
  const textarea = await page.locator('.xterm-helper-textarea').elementHandle();
  const cover = () => page.evaluate(() => window.rippleFixture.boundary(0));
  await cover();
  const projected = page.getByRole('group', { name: 'Live terminal input' });
  await projected.waitFor();
  await projected.focus();
  await page.keyboard.type('ripple-covered-draft');
  await page.waitForFunction(() =>
    document.querySelector('.ripple-input')?.textContent.includes('ripple-covered-draft'),
  );
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() =>
    document.querySelector('.ripple-input')?.textContent.includes('ripple-covered-drat'),
  );
  await page.keyboard.press('Control+u');
  await page.keyboard.press('Control+k');
  const draft = 'ripple-wrapped-input '.repeat(20);
  await page.keyboard.insertText(draft);
  await page.waitForFunction(() =>
    document.querySelector('.ripple-input')?.textContent.includes('ripple-wrapped-input'),
  );
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.waitForTimeout(300);
  assert.ok(
    await textarea.evaluate(
      (el) => document.activeElement === el && el.classList.contains('ripple-input-target'),
    ),
  );
  const caret = await page.locator('.ripple-input-caret').boundingBox();
  const pane = await page.locator('.ripple').boundingBox();
  assert.ok(
    caret.y >= pane.y && caret.y + caret.height <= pane.y + pane.height + 1,
    'editing caret stays visible after wrapping and resize',
  );
  await page.screenshot({ path: '/private/tmp/puddle-ripple-live-input.png' });
  await page.evaluate(() => window.rippleFixture.enable(false));
  await projected.waitFor({ state: 'detached' });
  await page.waitForFunction(() =>
    document.querySelector('.xterm-rows').textContent.includes('ripple-wrapped-input'),
  );
  assert.ok(
    await textarea.evaluate(
      (el) =>
        el === document.querySelector('.xterm-helper-textarea') &&
        !el.classList.contains('ripple-input-target'),
    ),
  );
  await cover();
  await projected.waitFor();
  await projected.focus();
  await page.keyboard.press('Control+u');
  await page.keyboard.press('Control+k');
  assert.deepEqual(errors, []);
  console.log(
    'Real Codex: Ripple typing, cursor editing, wrapped input, resize, native input restoration and draft preservation pass.',
  );
} finally {
  stopped = true;
  await pump?.catch(() => {});
  proc?.kill();
  await browser.close();
}
