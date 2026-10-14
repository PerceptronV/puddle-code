import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';

test.use({ viewport: { width: 1000, height: 800 } });
let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: fileURLToPath(new URL('../vite.build.config.ts', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture server port');
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => server?.close());

/** Compare decorations with the browser's actual glyph cells, not Monaco's cached metrics. */
async function bracketOffsets(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const line = document.querySelector('#root .view-line')!;
    const cells: DOMRect[] = [];
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      for (let index = 0; index < text.length; index++) {
        if (text[index] !== '{' && text[index] !== '}') continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        cells.push(range.getBoundingClientRect());
      }
    }
    const highlights = [...document.querySelectorAll('#root .bracket-match')]
      .map((element) => element.getBoundingClientRect())
      .sort((a, b) => a.left - b.left);
    return cells.map((cell, index) =>
      Math.max(
        Math.abs(cell.left - highlights[index]!.left),
        Math.abs(cell.right - highlights[index]!.right),
      ),
    );
  });
}

test('bracket highlights follow the glyphs when the editor font finishes loading', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let releaseFont!: () => void;
  const fontHeld = new Promise<void>((resolve) => {
    releaseFont = resolve;
  });
  await page.route('**/UbuntuSansMono-variable.woff2', async (route) => {
    await fontHeld;
    await route.continue();
  });
  await page.route(`${origin}/api/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/file'))
      return route.fulfill({
        json: { path: 'file.txt', binary: false, mtime_ms: 1, content: '\\begin{document}' },
      });
    if (path.endsWith('/version'))
      return route.fulfill({ json: { protocol: { major: 22, minor: 0 } } });
    return route.fulfill({ json: {} });
  });
  try {
    await page.goto(`${origin}/e2e/fixtures/view-state.html?view=code`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('#root .view-line')).toHaveText('\\begin{document}');
    await page.evaluate(() => {
      const editor = window.viewFixture.editor();
      editor.updateOptions({ fontSize: 30 });
      editor.setPosition({ lineNumber: 1, column: 17 });
      editor.focus();
    });
    await expect(page.locator('#root .bracket-match')).toHaveCount(2);
    expect(await page.evaluate(() => document.fonts.check('30px "Ubuntu Sans Mono"'))).toBe(false);
    await expect.poll(() => bracketOffsets(page)).toEqual([expect.any(Number), expect.any(Number)]);
    expect(Math.max(...(await bracketOffsets(page)))).toBeLessThan(1);

    releaseFont();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    expect(await page.evaluate(() => document.fonts.check('30px "Ubuntu Sans Mono"'))).toBe(true);
    await expect.poll(async () => Math.max(...(await bracketOffsets(page)))).toBeLessThan(1);
    expect(errors).toEqual([]);
  } finally {
    releaseFont();
  }
});
