import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

test.use({
  hasTouch: true,
  isMobile: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
});

// Real xterm and native browser events, isolated from a daemon or coding-agent process.
let javascript: Uint8Array;
let css: Uint8Array;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/mobile-editing.tsx', import.meta.url))],
    bundle: true,
    write: false,
    outfile: 'editing.js',
    format: 'esm',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
  });
  javascript = result.outputFiles!.find((file) => file.path.endsWith('.js'))!.contents;
  css = result.outputFiles!.find((file) => file.path.endsWith('.css'))!.contents;
});
test.beforeEach(async ({ page }) => {
  await page.route('http://editing.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/editing.js')
      await route.fulfill({ contentType: 'text/javascript', body: Buffer.from(javascript) });
    else if (pathname === '/editing.css')
      await route.fulfill({ contentType: 'text/css', body: Buffer.from(css) });
    else
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/editing.css"></head><body><div id="terminal"></div><div id="controls"></div><div id="diff"></div><script type="module" src="/editing.js"></script></body></html>',
      });
  });
  await page.goto('http://editing.test/');
  await page.waitForFunction(() => 'editing' in window);
  await page.locator('.xterm-screen').tap();
});

declare global {
  interface Window {
    editing: {
      input(): string;
      clear(): void;
      focus(): void;
      active(value: boolean): void;
      write(data: string): Promise<void>;
      cell(column: number, row: number): { x: number; y: number };
    };
  }
}
const input = (page: Page) => page.evaluate(() => window.editing.input());
const clear = (page: Page) => page.evaluate(() => window.editing.clear());

const PAD = '        \n        \n        ';
const CENTRE = 13;
async function moveCaret(page: Page, offset: number) {
  await page.locator('textarea').evaluate((element, offset) => {
    element.setSelectionRange(offset, offset);
  }, offset);
}
async function beforeInput(page: Page, inputType: string, data: string | null = null) {
  await page.locator('textarea').evaluate(
    (element, { inputType, data }) => {
      element.dispatchEvent(
        new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data }),
      );
    },
    { inputType, data },
  );
}

test('spacebar trackpad steps send one arrow each and never exhaust the padding', async ({
  page,
}) => {
  const textarea = page.locator('textarea');
  await expect(textarea).toHaveValue(PAD);
  for (const [offset, key] of [
    [CENTRE - 1, 'D'],
    [CENTRE + 1, 'C'],
    [CENTRE - 9, 'A'],
    [CENTRE + 9, 'B'],
    // A leap to either end, as iOS makes at a row boundary, is still one step.
    [0, 'A'],
    [PAD.length, 'B'],
    [CENTRE + 4, 'C'],
  ] as const) {
    await clear(page);
    await moveCaret(page, offset);
    await expect.poll(() => input(page)).toBe(`\x1b[${key}`);
    await expect.poll(() => textarea.evaluate((element) => element.selectionEnd)).toBe(CENTRE);
  }
  await clear(page);
  await page.evaluate(() => window.editing.write('\x1b[?1h'));
  await moveCaret(page, CENTRE - 1);
  await expect.poll(() => input(page)).toBe('\x1bOD');
  await expect(textarea).toHaveValue(PAD);
});

test('keys, keyless insertions and IME commits arrive once without editing the padding', async ({
  page,
}) => {
  const textarea = page.locator('textarea');
  await page.keyboard.type('hi');
  await page.keyboard.press('Backspace');
  expect(await input(page)).toBe('hi\x7f');
  await clear(page);
  await beforeInput(page, 'insertText', 'predicted ');
  await beforeInput(page, 'deleteContentBackward');
  await beforeInput(page, 'insertReplacementText', 'ignored');
  expect(await input(page)).toBe('predicted \x7f');
  await expect(textarea).toHaveValue(PAD);
  await clear(page);
  await textarea.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, keyCode: 229, isComposing: true }),
    );
    element.value = element.value.slice(0, 13) + '日本' + element.value.slice(13);
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本' }));
  });
  await page.waitForTimeout(50);
  expect(await input(page)).toBe('日本');
  await expect(textarea).toHaveValue(PAD);
  await clear(page);
  await page.evaluate(() => window.editing.active(false));
  await beforeInput(page, 'insertText', 'hidden');
  await moveCaret(page, CENTRE - 1);
  await expect.poll(() => textarea.evaluate((element) => element.selectionEnd)).toBe(CENTRE);
  expect(await input(page)).toBe('');
});

test('spaces and capital letters handled by xterm arrive once', async ({ page }) => {
  for (const text of [' ', '  ', 'Hi There']) {
    await clear(page);
    await page.keyboard.type(text);
    expect(await input(page)).toBe(text);
    await expect(page.locator('textarea')).toHaveValue(PAD);
  }
});

test('taps focus without moving the caret and reach mouse-aware applications', async ({ page }) => {
  await page.evaluate(() => window.editing.write('› hello world'));
  await clear(page);
  const point = await page.evaluate(() => window.editing.cell(4, 0));
  await page.touchscreen.tap(point.x, point.y);
  await expect(page.locator('textarea')).toBeFocused();
  expect(await input(page)).toBe('');
  await page.evaluate(() => window.editing.write('\x1b[?1000h\x1b[?1006h'));
  await page.touchscreen.tap(point.x, point.y);
  await expect.poll(() => input(page)).toBe('\x1b[<0;5;1M\x1b[<0;5;1m');
});

test('rapid command taps retain focus and send each key once; dragging sends nothing', async ({
  page,
}) => {
  const textarea = page.locator('textarea');
  let blurs = 0;
  await page.exposeFunction('recordBlur', () => {
    blurs++;
  });
  await textarea.evaluate((element) =>
    element.addEventListener('blur', () => {
      void (window as unknown as { recordBlur(): Promise<void> }).recordBlur();
    }),
  );
  for (const label of ['Left', 'Right', 'Esc', 'Left', 'Right'])
    await page.getByRole('button', { name: label, exact: true }).tap();
  expect(await input(page)).toBe('\x1b[D\x1b[C\x1b\x1b[D\x1b[C');
  await expect(textarea).toBeFocused();
  expect(blurs).toBe(0);
  await page.getByRole('button', { name: 'Right', exact: true }).click();
  expect(await input(page)).toBe('\x1b[D\x1b[C\x1b\x1b[D\x1b[C\x1b[C');
  await clear(page);
  const button = page.getByRole('button', { name: 'Left', exact: true });
  await button.dispatchEvent('touchstart', {
    touches: [{ identifier: 0, clientX: 50, clientY: 50 }],
  });
  await button.dispatchEvent('touchmove', {
    touches: [{ identifier: 0, clientX: 90, clientY: 50 }],
  });
  await button.dispatchEvent('touchend', { touches: [] });
  expect(await input(page)).toBe('');
  await expect(textarea).toBeFocused();
  // A tap between keys, with the keyboard dismissed, raises it again.
  await textarea.evaluate((element) => element.blur());
  const strip = (await page.locator('.phone-keys').boundingBox())!;
  await page.touchscreen.tap(strip.x + 8, strip.y + strip.height / 2);
  await expect(textarea).toBeFocused();
  expect(await input(page)).toBe('');
});

test('diffs stack highlighted numbered panes and keep source inert', async ({ page }) => {
  const before = page.getByLabel('Before', { exact: true });
  const after = page.getByLabel('After', { exact: true });
  expect((await after.boundingBox())!.y).toBeGreaterThan((await before.boundingBox())!.y);
  await expect(before.locator('mark')).toContainText(['old']);
  await expect(after.locator('[data-change="added"]')).toHaveCount(2);
  await expect(after).toContainText('<script>window.executed = true</script>');
  expect(await page.evaluate(() => 'executed' in window)).toBe(false);
  await expect(after.locator('.phone-diff-number')).toHaveText(['1', '2', '3', '4']);
});
