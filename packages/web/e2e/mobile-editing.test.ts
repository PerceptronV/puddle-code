import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

test.use({ hasTouch: true, isMobile: true });

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

async function nativeReplacement(
  page: Page,
  text: string,
  cursor: number,
  type = 'insertReplacementText',
) {
  await page.locator('textarea').evaluate(
    (element, { text, cursor, type }) => {
      element.value = text;
      element.setSelectionRange(cursor, cursor);
      element.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: type, data: text }),
      );
    },
    { text, cursor, type },
  );
}

test('native suggestions replace words; composition and Unicode arrive exactly once', async ({
  page,
}) => {
  await expect(page.locator('textarea')).toHaveAttribute('autocorrect', 'on');
  await page.keyboard.type('teh cat');
  expect(await input(page)).toBe('teh cat');
  await clear(page);
  await nativeReplacement(page, 'the cat', 7);
  expect(await input(page)).toBe('\x1b[D'.repeat(4) + '\x7f\x7fhe' + '\x1b[C'.repeat(4));
  await page.keyboard.press('Enter');
  await clear(page);
  await page.locator('textarea').evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.value = '日本語 🌊';
    element.setSelectionRange(element.value.length, element.value.length);
    element.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        isComposing: true,
        inputType: 'insertCompositionText',
        data: element.value,
      }),
    );
    element.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: element.value }),
    );
    element.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: element.value }),
    );
  });
  expect(await input(page)).toBe('日本語 🌊');
});

test('native caret movement and selection replacement edit in the middle', async ({ page }) => {
  await page.keyboard.type('hello world');
  await clear(page);
  await page.locator('textarea').evaluate((element) => {
    element.setSelectionRange(5, 5);
  });
  await expect.poll(() => input(page)).toBe('\x1b[D'.repeat(6));
  await clear(page);
  await page.keyboard.type('!');
  expect(await input(page)).toBe('!');
  await expect(page.locator('textarea')).toHaveValue('hello! world');
  await page.locator('textarea').evaluate((element) => {
    element.setSelectionRange(0, 5);
  });
  await expect.poll(() => input(page)).toBe('!\x1b[D');
  await clear(page);
  await page.keyboard.type('Hi');
  expect(await input(page)).toBe('\x7f'.repeat(5) + 'Hi');
});

test('taps reposition within verified terminal input and leave transcript taps alone', async ({
  page,
}) => {
  await page.keyboard.type('hello world');
  await page.evaluate(() => window.editing.write('\x1b[2J\x1b[H› hello world'));
  await clear(page);
  const point = await page.evaluate(() => window.editing.cell(7, 0));
  await page.touchscreen.tap(point.x, point.y);
  await expect.poll(() => input(page)).toBe('\x1b[D'.repeat(6));
  await clear(page);
  const output = await page.evaluate(() => window.editing.cell(4, 4));
  await page.touchscreen.tap(output.x, output.y);
  expect(await input(page)).toBe('');
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
});

test('hidden or disconnected inputs cannot commit a pending composition', async ({ page }) => {
  await page.locator('textarea').dispatchEvent('compositionstart');
  await page.evaluate(() => window.editing.active(false));
  await nativeReplacement(page, 'do not send', 11);
  await page.locator('textarea').dispatchEvent('compositionend', { data: 'do not send' });
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

for (const [text, screen, column, offset] of [
  ['first words second row', '› first words\r\n  second row', 8, 6],
  ['abcdefghijklmnopqrstuvwxyz0123456789', '› abcdefghijklmnopqrstuvwxyz0123456789', 5, 3],
  ['hi 🌊 there', '› hi 🌊 there', 5, 3],
] as const) {
  test(`tap placement follows wrapped and wide text: ${text}`, async ({ page }) => {
    await nativeReplacement(page, text, text.length, 'insertText');
    expect(await input(page)).toBe(text);
    await page.evaluate((screen) => window.editing.write('\x1b[2J\x1b[H' + screen), screen);
    await clear(page);
    const point = await page.evaluate((column) => window.editing.cell(column, 0), column);
    await page.touchscreen.tap(point.x, point.y);
    await expect
      .poll(() => input(page))
      .toBe('\x1b[D'.repeat(Array.from(text.slice(offset)).length));
  });
}

test('IME candidates stay visible and a cancelled composition cannot cross reconnection', async ({
  page,
}) => {
  const textarea = page.locator('textarea');
  await textarea.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.dispatchEvent(
      new CompositionEvent('compositionupdate', { bubbles: true, data: '日本' }),
    );
  });
  await expect(page.locator('.terminal-native-composition')).toHaveText('日本');
  await expect(page.locator('.terminal-native-composition')).toBeVisible();
  expect(await input(page)).toBe('');
  await page.evaluate(() => {
    window.editing.active(false);
    window.editing.active(true);
  });
  await nativeReplacement(page, '日本', 2);
  await textarea.dispatchEvent('compositionend', { data: '日本' });
  expect(await input(page)).toBe('');
  await expect(page.locator('.terminal-native-composition')).toBeHidden();
});
