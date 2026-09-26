import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import type { FileLinkTarget } from '../src/features/terminal/file-links';

test.use({
  viewport: { width: 900, height: 600 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
let javascript: Uint8Array;
let css: Uint8Array;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/terminal-interactions.ts', import.meta.url))],
    bundle: true,
    write: false,
    outfile: 'interactions.js',
    format: 'esm',
  });
  javascript = result.outputFiles!.find((file) => file.path.endsWith('.js'))!.contents;
  css = result.outputFiles!.find((file) => file.path.endsWith('.css'))!.contents;
});
test.beforeEach(async ({ page }) => {
  await page.route('https://terminal.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/interactions.js')
      await route.fulfill({ contentType: 'text/javascript', body: Buffer.from(javascript) });
    else if (url.pathname === '/interactions.css')
      await route.fulfill({ contentType: 'text/css', body: Buffer.from(css) });
    else if (url.pathname.endsWith('/resolve')) {
      const path = url.searchParams.get('path');
      if (path === 'src/features/terminal/file-links.ts' || path === 'src/file.ts')
        await route.fulfill({ json: { kind: 'file', path, line: null } });
      else if (path === 'src/features/')
        await route.fulfill({ json: { kind: 'dir', path: '/worktree/src/features', line: null } });
      else await route.fulfill({ status: 404, json: {} });
    } else
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><link rel="stylesheet" href="/interactions.css"><div id="terminal"></div><script type="module" src="/interactions.js"></script>',
      });
  });
  await page.goto('https://terminal.test/');
  await page.waitForFunction(() => 'terminalInteractions' in window);
});

declare global {
  interface Window {
    terminalInteractions: {
      input(): string[];
      opened(): FileLinkTarget[];
      errors(): string[];
      selection(): string;
      applicationText(text: string): void;
      focus(): void;
      write(data: string, replay?: boolean): Promise<void>;
      cell(column: number, row: number): { x: number; y: number };
    };
  }
}

async function selectInApplication(page: Page) {
  await page.evaluate(async () => {
    await navigator.clipboard.writeText('unchanged');
    await window.terminalInteractions.write('\x1b[?1049h\x1b[?1003h\x1b[?1006hremote selection');
    window.terminalInteractions.focus();
  });
  const start = await page.evaluate(() => window.terminalInteractions.cell(0, 0));
  const end = await page.evaluate(() => window.terminalInteractions.cell(15, 0));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.terminalInteractions.selection())).toBe('');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('unchanged');
}

for (const shortcut of ['Control+c', 'Meta+c']) {
  test(`normal TUI drag and ${shortcut} copies the delayed OSC reply on the first press`, async ({
    page,
  }) => {
    await selectInApplication(page);
    await page.keyboard.press(shortcut);
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('remote selection');
    expect(await page.evaluate(() => window.terminalInteractions.errors())).toEqual([]);
    if (shortcut === 'Meta+c')
      expect(await page.evaluate(() => window.terminalInteractions.input())).not.toContain('\x03');
  });
}

test('desktop Copy reaches the application without a keydown', async ({ page }) => {
  await selectInApplication(page);
  await page
    .locator('textarea')
    .evaluate((element) =>
      element.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true })),
    );
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('remote selection');
});

test('a new application selection replaces the previous OSC copy', async ({ page }) => {
  await selectInApplication(page);
  await page.keyboard.press('Meta+c');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('remote selection');
  await page.evaluate(async () => {
    window.terminalInteractions.applicationText('second selection');
    await window.terminalInteractions.write('\x1b[Hsecond selection');
  });
  const start = await page.evaluate(() => window.terminalInteractions.cell(0, 0));
  const end = await page.evaluate(() => window.terminalInteractions.cell(15, 0));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press('Meta+c');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('second selection');
});

test('Ctrl-C copies a forced local selection without reaching the application', async ({
  page,
}) => {
  await page.evaluate(async () => {
    await window.terminalInteractions.write('\x1b[?1003h\x1b[?1006hlocal selection');
    window.terminalInteractions.focus();
  });
  const start = await page.evaluate(() => window.terminalInteractions.cell(0, 0));
  const end = await page.evaluate(() => window.terminalInteractions.cell(15, 0));
  const modifier = await page.evaluate(() => (/Mac/.test(navigator.platform) ? 'Alt' : 'Shift'));
  await page.keyboard.down(modifier);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up(modifier);
  const selection = await page.evaluate(() => window.terminalInteractions.selection());
  expect(selection).toContain('local selection');
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(selection);
  expect(await page.evaluate(() => window.terminalInteractions.input())).not.toContain('\x03');
});

test('highlighting and replayed OSC output do not overwrite the clipboard', async ({ page }) => {
  await page.evaluate(async () => {
    await navigator.clipboard.writeText('unchanged');
    const osc = `\x1b]52;c;${btoa('historical selection')}\x07`;
    await window.terminalInteractions.write(osc);
    await window.terminalInteractions.write(osc, true);
    window.terminalInteractions.focus();
  });
  await page.keyboard.press('Meta+c');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('unchanged');
});

test('every row of an indented hard-wrapped file opens the complete target', async ({ page }) => {
  await page.evaluate(() =>
    window.terminalInteractions.write(
      '  see src/features/\r\n    terminal/file-\r\n    links.ts:12:3',
    ),
  );
  for (const row of [0, 1, 2]) {
    const cell = await page.evaluate((row) => window.terminalInteractions.cell(7, row), row);
    await page.mouse.move(cell.x, cell.y);
    await expect(page.locator('.xterm-screen')).toHaveClass(/xterm-cursor-pointer/);
    await page.keyboard.down('Meta');
    await page.mouse.click(cell.x, cell.y);
    await page.keyboard.up('Meta');
    await expect
      .poll(() => page.evaluate(() => window.terminalInteractions.opened()))
      .toHaveLength(row + 1);
  }
  expect(await page.evaluate(() => window.terminalInteractions.opened())).toEqual(
    Array(3).fill({
      kind: 'file',
      path: 'src/features/terminal/file-links.ts',
      line: 12,
      column: 3,
    }),
  );
});

test('wide glyphs before a soft-wrapped path retain clickable cell coordinates', async ({
  page,
}) => {
  await page.evaluate(() => window.terminalInteractions.write('日本語 🌊 src/file.ts:123:4'));
  const cell = await page.evaluate(() => window.terminalInteractions.cell(1, 1));
  await page.mouse.move(cell.x, cell.y);
  await expect(page.locator('.xterm-screen')).toHaveClass(/xterm-cursor-pointer/);
  await page.keyboard.down('Meta');
  await page.mouse.click(cell.x, cell.y);
  await page.keyboard.up('Meta');
  await expect
    .poll(() => page.evaluate(() => window.terminalInteractions.opened()))
    .toEqual([{ kind: 'file', path: 'src/file.ts', line: 123, column: 4 }]);
});
