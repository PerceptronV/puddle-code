import { test, expect } from '@playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {} from './fixtures/terminal-rich-output';

test.use({ viewport: { width: 1100, height: 750 } });
test.setTimeout(30_000);
let directory: string;
let server: PreviewServer;
let origin: string;
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'puddle-terminal-rich-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  // Vite's build and preview set NODE_ENV. Restore it before another fixture
  // starts a dev server in this worker, or React Refresh loses its preamble.
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    await build({
      root,
      configFile: join(root, 'vite.build.config.ts'),
      logLevel: 'error',
      build: {
        outDir: directory,
        emptyOutDir: true,
        rollupOptions: { input: join(root, 'e2e/fixtures/terminal-rich-output.html') },
      },
    });
    server = await preview({
      root,
      configFile: false,
      build: { outDir: directory },
      preview: { host: '127.0.0.1', port: 0 },
    });
    const address = server.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    origin = `http://127.0.0.1:${address.port}`;
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
test.afterAll(async () => {
  await server?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
test.beforeEach(async ({ page }) => {
  await page.goto(`${origin}/e2e/fixtures/terminal-rich-output.html`);
  await page.waitForFunction(() => !!window.richTerminal);
});

const diagram =
  'flowchart TB\r\n  U[User]\r\n\r\n  subgraph APP[Application]\r\n    A[Chat and history]\r\n    H[Model and observations]\r\n    A <--> H\r\n  end\r\n\r\n  U <--> A\r\n\r\n';
const equation = '$$\r\nJ\\dddot e+(b+K_D)\\ddot e+K_P\\dot e+K_Ie=0.\r\n$$\r\n';

test('renders diagrams and equations directly in their source rows, with theme changes', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluate(
    (text) => window.richTerminal.write(text),
    diagram + equation + '\r\nReady > ',
  );
  const blocks = page.locator('[data-terminal-rich-block][data-rendered="true"]');
  await expect(blocks).toHaveCount(2);
  await expect(page.locator('[data-terminal-rich-block="mermaid"] svg.flowchart')).toBeVisible();
  const title = await page.locator('svg.flowchart .cluster-label').boundingBox();
  const node = await page
    .locator('svg.flowchart g.node')
    .filter({ hasText: 'Chat and history' })
    .boundingBox();
  expect(title!.y + title!.height).toBeLessThanOrEqual(node!.y);
  const user = await page.locator('svg.flowchart g.node').filter({ hasText: 'User' }).boundingBox();
  const cluster = await page.locator('svg.flowchart g.cluster > rect').boundingBox();
  expect(user!.y + user!.height).toBeLessThanOrEqual(cluster!.y);
  await expect(page.getByRole('math')).toBeVisible();
  const before = await page.evaluate(() => window.richTerminal.text());
  const contentFits = await blocks.evaluateAll((blocks) =>
    blocks.every((block) => {
      const frame = block.getBoundingClientRect();
      const content = block.firstElementChild!.getBoundingClientRect();
      return content.width <= frame.width + 1 && content.height <= frame.height + 1;
    }),
  );
  expect(contentFits).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('terminal-rich-light.png') });
  await page.evaluate(() => window.richTerminal.theme('dark'));
  await expect(blocks).toHaveCount(2);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => window.richTerminal.text())).toBe(before);
  await page.screenshot({ path: testInfo.outputPath('terminal-rich-dark.png') });
  expect(errors).toEqual([]);
});

test('source toggles and local selection expose the original terminal text', async ({ page }) => {
  await page.evaluate((text) => window.richTerminal.write(text), equation);
  const block = page.locator('[data-terminal-rich-block="math"]');
  await expect(block).toHaveAttribute('data-rendered', 'true');
  await page.locator('.xterm-screen').hover();
  await page.getByRole('button', { name: 'Show terminal source' }).click();
  await expect(block).toHaveAttribute('data-rendered', 'false');
  await page.getByRole('button', { name: 'Render LaTeX' }).click();
  await expect(block).toHaveAttribute('data-rendered', 'true');
  await page.evaluate(() => window.richTerminal.select(0, 1, 12));
  await expect(page.getByRole('math')).toBeHidden();
  expect(await page.evaluate(() => window.richTerminal.selection())).toBe('J\\dddot e+(b');
  await page.evaluate(() => window.richTerminal.clearSelection());
  await expect(page.getByRole('math')).toBeVisible();
});

test('incomplete output stays literal and overwritten output loses its overlay', async ({
  page,
}) => {
  await page.evaluate(() => window.richTerminal.write('$$\r\nx^2\r\n'));
  await expect(page.locator('[data-terminal-rich-block]')).toHaveCount(0);
  await page.evaluate(() => window.richTerminal.write('$$'));
  await expect(page.getByRole('math')).toBeVisible();
  await page.evaluate(() => window.richTerminal.write('\x1b[2J\x1b[HReady > '));
  await expect(page.locator('[data-terminal-rich-block]')).toHaveCount(0);
  await page.locator('.xterm-screen').click({ position: { x: 80, y: 10 } });
  await page.keyboard.type('hello');
  expect(await page.evaluate(() => window.richTerminal.input.join(''))).toContain('hello');
});

test('unrelated TUI redraws retain existing maths while new blocks appear', async ({ page }) => {
  await page.evaluate((text) => window.richTerminal.write(text), equation);
  await expect(page.getByRole('math')).toBeVisible();
  for (let index = 0; index < 8; index++) {
    await page.evaluate(async (index) => {
      await window.richTerminal.write(`\x1b[10;1HWorking ${index}`);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    }, index);
    expect(await page.getByRole('math').isVisible()).toBe(true);
  }
  await page.evaluate(() => window.richTerminal.write('\x1b[5;1H$$y^2$$\r\n'));
  await expect(page.getByRole('math')).toHaveCount(2);
});

test('normal scrollback and alternate screens keep independent overlays', async ({ page }) => {
  await page.evaluate((text) => window.richTerminal.write(text), equation);
  await expect(page.getByRole('math')).toBeVisible();
  await page.evaluate(() => window.richTerminal.write('\x1b[?1049hAlternate application'));
  await expect(page.locator('[data-terminal-rich-block]')).toHaveCount(0);
  await page.evaluate(() => window.richTerminal.write('\x1b[?1049l'));
  await expect(page.getByRole('math')).toBeVisible();
  await page.evaluate(() => window.richTerminal.write('\r\n'.repeat(45)));
  await expect(page.locator('[data-terminal-rich-block]')).toHaveCount(0);
  await page.evaluate(() => window.richTerminal.scroll(1));
  await expect(page.getByRole('math')).toBeVisible();
});

test('wide glyphs and resize reflow retain the source cell coordinates', async ({ page }) => {
  await page.evaluate(() =>
    window.richTerminal.write('日本語 🌊 $x^2$\r\n$$abcdefghijklmno$$\r\n'),
  );
  await expect(page.getByRole('math')).toHaveCount(2);
  const first = page.locator('[data-terminal-rich-block]').first();
  const left = await first.evaluate((node) => (node as HTMLElement).offsetLeft);
  const screen = await page.locator('.xterm-screen').boundingBox();
  // xterm's default Unicode table gives the three CJK glyphs two cells each
  // and this emoji one; neither JavaScript UTF-16 length nor glyph count fits.
  expect(left).toBeCloseTo((screen!.width / 100) * 9, 0);
  await page.evaluate(() => window.richTerminal.resize(12));
  await expect(page.locator('[data-terminal-rich-block][data-rendered="true"]')).toHaveCount(1);
  await page.evaluate(() => window.richTerminal.resize(100));
  await expect(page.locator('[data-terminal-rich-block][data-rendered="true"]')).toHaveCount(2);
});

test('invalid and untrusted source remains inert', async ({ page }) => {
  await page.evaluate(() =>
    window.richTerminal.write(
      '```mermaid\r\nflowchart TB\r\n  A[broken\r\n```\r\n$$\\frac{$$\r\n$\\href{javascript:alert(1)}{x}$',
    ),
  );
  await expect(page.locator('[data-terminal-rich-block="mermaid"] button')).toHaveAttribute(
    'title',
    /Unable to render/,
  );
  await expect(page.locator('[data-terminal-rich-block="mermaid"]')).toHaveAttribute(
    'data-rendered',
    'false',
  );
  expect(await page.locator('[data-terminal-rich-block] a').count()).toBe(0);
  expect(await page.locator('[data-terminal-rich-block] img').count()).toBe(0);
});
