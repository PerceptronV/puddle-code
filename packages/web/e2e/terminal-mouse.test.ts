import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalScreenStateStore } from '../../daemon/src/pty/terminal-screen-state';

test.use({ viewport: { width: 1000, height: 700 } });

let javascript: Uint8Array;
let css: Uint8Array;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/terminal-mouse.ts', import.meta.url))],
    bundle: true,
    write: false,
    outfile: 'mouse.js',
    format: 'esm',
  });
  javascript = result.outputFiles!.find((file) => file.path.endsWith('.js'))!.contents;
  css = result.outputFiles!.find((file) => file.path.endsWith('.css'))!.contents;
});

test.beforeEach(async ({ page }) => {
  await page.route('http://terminal.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/mouse.js')
      await route.fulfill({ contentType: 'text/javascript', body: Buffer.from(javascript) });
    else if (pathname === '/mouse.css')
      await route.fulfill({ contentType: 'text/css', body: Buffer.from(css) });
    else
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><head><link rel="stylesheet" href="/mouse.css"></head><body><div id="terminal"></div><script type="module" src="/mouse.js"></script></body></html>',
      });
  });
  await page.goto('http://terminal.test/');
  await page.waitForFunction(() => 'terminalMouse' in window);
});

declare global {
  interface Window {
    terminalMouse: {
      input(): string[];
      clear(): void;
      write(data: string, replay: boolean): Promise<void>;
      cell(column: number, row: number): { x: number; y: number };
    };
  }
}

async function expectMouseInput(page: Page) {
  const start = await page.evaluate(() => window.terminalMouse.cell(5, 3));
  const end = await page.evaluate(() => window.terminalMouse.cell(15, 3));
  await page.mouse.move(start.x, start.y);
  await page.evaluate(() => window.terminalMouse.clear());
  await page.mouse.wheel(0, -200);
  await expect
    .poll(() => page.evaluate(() => window.terminalMouse.input()))
    .toContain('\x1b[<64;6;4M');
  await page.mouse.wheel(0, 200);
  await expect
    .poll(() => page.evaluate(() => window.terminalMouse.input()))
    .toContain('\x1b[<65;6;4M');
  await page.evaluate(() => window.terminalMouse.clear());
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.terminalMouse.input())).toEqual(
    expect.arrayContaining(['\x1b[<0;6;4M', '\x1b[<32;16;4M', '\x1b[<0;16;4m']),
  );
}

for (const buffer of ['normal', 'alternate']) {
  test(`wheel and drag input survive ${buffer} terminal replay and persistence`, async ({
    page,
  }) => {
    const stateDir = await mkdtemp(join(tmpdir(), 'puddle-browser-mouse-'));
    let store = new TerminalScreenStateStore(stateDir);
    try {
      // Standard fullscreen/SGR modes, also observed from Codex CLI 0.157.1.
      const startup = `${buffer === 'alternate' ? '\x1b[?1049h' : ''}\x1b[?1003h\x1b[?1006htranscript`;
      store.resize('session', 'agent', 80, 24);
      store.write('session', 'agent', startup);
      await page.evaluate((data) => window.terminalMouse.write(data, false), startup);
      await expectMouseInput(page);
      for (const persisted of [false, true]) {
        if (persisted) {
          await store.closeAll();
          store = new TerminalScreenStateStore(stateDir);
        }
        const snapshot = await store.snapshot('session', 'agent');
        expect(snapshot).not.toBeNull();
        // Replay resets a cached viewer, just as reconnect or reattachment does.
        await page.evaluate((data) => window.terminalMouse.write(data!, true), snapshot);
        await expectMouseInput(page);
      }
    } finally {
      await store.closeAll();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
}
