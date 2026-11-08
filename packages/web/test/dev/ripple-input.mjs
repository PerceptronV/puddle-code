/* global window, document, ClipboardEvent, DataTransfer, CompositionEvent */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
try {
  for (const mobile of [false, true]) {
    const page = await browser.newPage({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1300, height: 1000 },
      hasTouch: mobile,
      isMobile: mobile,
      reducedMotion: 'reduce',
    });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(
      new URL(
        `/e2e/fixtures/ripple.html?live&ripple${mobile ? '&mobile' : ''}`,
        process.env.PREVIEW_URL ?? 'http://127.0.0.1:5174/',
      ).href,
    );
    await page.waitForFunction(() => window.rippleFixture?.messages.some((m) => m.t === 'attach'));
    await page.waitForTimeout(150);
    const size = await page.evaluate(() =>
      window.rippleFixture.messages.findLast((m) => m.t === 'attach' || m.t === 'resize'),
    );
    const row = size.rows - 3;
    const output = (data) => page.evaluate((data) => window.rippleFixture.output(data), data);
    const inputs = () =>
      page.evaluate(() =>
        window.rippleFixture.messages.filter((m) => m.t === 'stdin').map((m) => m.data),
      );
    const boundary = (rows) => page.evaluate((rows) => window.rippleFixture.boundary(rows), rows);
    const draft = '› **Draft** 界é';
    await output(
      '\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[2J\x1b[H• Existing reply\r\nDisplay only stays unchanged.' +
        `\x1b[${row};1H${draft}\x1b[${row + 1};1H  continuation <literal>\x1b[${size.rows};1HFooter\x1b[${row};4H`,
    );
    await page
      .locator('.ripple-prose')
      .getByText('Display only stays unchanged.', { exact: true })
      .waitFor();
    assert.equal(
      await page.locator('.ripple-input').count(),
      0,
      'default split leaves input native',
    );
    const textarea = await page.locator('.xterm-helper-textarea').elementHandle();
    const handle = await page.getByRole('separator', { name: 'Native CLI boundary' }).boundingBox();
    const pane = await page.locator('.puddle-terminal-ripple').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, pane.y + pane.height - 1, { steps: 8 });
    await page.mouse.up();
    const projection = page.getByRole('group', { name: 'Live terminal input' });
    await projection.waitFor();
    const coverage = await page.evaluate(() => {
      const reader = document.querySelector('.ripple').getBoundingClientRect();
      const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
      const pane = document.querySelector('.puddle-terminal-ripple').getBoundingClientRect();
      return {
        left: reader.left - screen.left,
        right: screen.right - reader.right,
        bottom: pane.bottom - reader.bottom,
      };
    });
    assert.ok(
      coverage.left <= 0 && coverage.right <= 0 && Math.abs(coverage.bottom) < 1,
      `full coverage must not expose native cells beside projected input: ${JSON.stringify(coverage)}`,
    );
    assert.ok((await projection.innerText()).includes(draft), 'draft Markdown stays literal');
    assert.equal(await projection.locator('strong').count(), 0);
    assert.ok((await projection.innerText()).includes('continuation <literal>'));
    const cell = projection.locator(`[data-ripple-input-row="${row - 1}"] [data-ripple-col="3"]`);
    const beforeClick = (await inputs()).length;
    if (mobile) await cell.tap();
    else await cell.click();
    assert.ok(await textarea.evaluate((el) => document.activeElement === el));
    assert.deepEqual((await inputs()).slice(beforeClick), [
      `\x1b[<0;4;${row}M`,
      `\x1b[<0;4;${row}m`,
    ]);
    const beforeType = (await inputs()).length;
    await page.keyboard.type('abc');
    await page.keyboard.insertText('日本語🌊');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Enter');
    assert.equal((await inputs()).slice(beforeType).join(''), 'abc日本語🌊\x1b[D\x7f\r');
    const beforePaste = (await inputs()).length;
    await textarea.evaluate((el) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', 'one\ntwo');
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
      );
    });
    await page.waitForTimeout(50);
    assert.equal((await inputs()).slice(beforePaste).join(''), '\x1b[200~one\rtwo\x1b[201~');
    // Cursor-only escape sequences must move both the projected caret and IME target.
    const old = await page.locator('.ripple-input-caret').boundingBox();
    await output(`\x1b[${row + 1};7H`);
    await page.waitForFunction(
      (y) => document.querySelector('.ripple-input-caret').getBoundingClientRect().y > y,
      old.y,
    );
    const caret = await page.locator('.ripple-input-caret').boundingBox();
    const inputBox = await textarea.boundingBox();
    assert.ok(
      Math.abs(caret.x - inputBox.x) < 1 && Math.abs(caret.y - inputBox.y) < 1,
      'IME textarea follows rendered caret',
    );
    // The existing native composition listener delivers the committed text once.
    const beforeIme = (await inputs()).length;
    await textarea.evaluate((el) => {
      el.value = '';
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      el.value = '漢';
      el.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '漢' }));
    });
    await page.locator('.ripple-input-composition').getByText('漢', { exact: true }).waitFor();
    await textarea.evaluate((el) =>
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '漢' })),
    );
    await page.waitForTimeout(80);
    assert.equal((await inputs()).slice(beforeIme).join(''), '漢');
    await output('\x1b[?25l');
    await page.waitForFunction(
      () => document.querySelector('.ripple-input-caret')?.dataset.visible === 'false',
    );
    await output('\x1b[?25h\x1b[?1000l');
    await page.waitForTimeout(50);
    const beforeNoMouse = (await inputs()).length;
    if (mobile) await cell.tap();
    else await cell.click();
    await page.keyboard.type('z');
    assert.equal(
      (await inputs()).slice(beforeNoMouse).join(''),
      'z',
      'no fake repositioning for CLIs without mouse support',
    );
    await boundary(null);
    await projection.waitFor({ state: 'detached' });
    assert.ok(
      await textarea.evaluate(
        (el) =>
          el === document.querySelector('.xterm-helper-textarea') &&
          !el.classList.contains('ripple-input-target'),
      ),
    );
    assert.equal(
      await page.evaluate(
        () => window.rippleFixture.messages.filter((m) => m.t === 'attach').length,
      ),
      1,
      'no reattach or replacement editor',
    );
    await page
      .locator('.ripple-prose')
      .getByText('Display only stays unchanged.', { exact: true })
      .waitFor();
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'Ripple covered input: native focus, anchored clicks, literal drafts, keyboard, paste, IME, cursor-only updates, mobile and default-split restoration pass.',
  );
} finally {
  await browser.close();
}
