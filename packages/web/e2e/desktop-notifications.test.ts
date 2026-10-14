import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';

test.use({ viewport: { width: 1100, height: 800 } });
let server: ViteDevServer;
let origin: string;
const sessionIds = [1, 2, 3].map((id) => `20000000-0000-4000-8000-00000000000${id}`);
declare global {
  interface Window {
    notificationFixture: {
      delivered(): (string | undefined)[];
      emit(index: number): Promise<void>;
      click(index: number): void;
    };
  }
}
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

test('only recent human input in the notifying terminal suppresses desktop delivery', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/e2e/fixtures/desktop-notifications.html`);
  const first = page.locator(`[data-notification-session="${sessionIds[0]}"]`);
  const second = page.locator(`[data-notification-session="${sessionIds[1]}"]`);
  await expect(first.locator('textarea')).toBeAttached();
  await expect(second.locator('textarea')).toBeAttached();
  // Focus alone, a visible sibling and a parked tab all still notify.
  await first.locator('textarea').focus();
  for (const index of [0, 1, 2])
    await page.evaluate((index) => window.notificationFixture.emit(index), index);
  expect(await page.evaluate(() => window.notificationFixture.delivered())).toEqual(sessionIds);

  await first.click();
  await page.keyboard.type('draft');
  await page.evaluate(() => window.notificationFixture.emit(0));
  expect(await page.evaluate(() => window.notificationFixture.delivered())).toEqual(sessionIds);
  await page.evaluate(() => window.notificationFixture.emit(1));
  expect(await page.evaluate(() => window.notificationFixture.delivered())).toEqual([
    ...sessionIds,
    sessionIds[1],
  ]);

  // Expiry is short and hovering/scrolling does not extend it.
  await page.clock.install();
  await first.click();
  await page.clock.runFor(5_001);
  await first.hover();
  await page.mouse.wheel(0, -100);
  await page.evaluate(() => window.notificationFixture.emit(0));
  expect(await page.evaluate(() => window.notificationFixture.delivered())).toHaveLength(5);

  // Working elsewhere or leaving the window clears suppression immediately.
  await first.click();
  await page.getByLabel('Elsewhere').click();
  await page.evaluate(() => window.notificationFixture.emit(0));
  expect(await page.evaluate(() => window.notificationFixture.delivered())).toHaveLength(6);
  await first.click();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await first.locator('textarea').focus();
  await page.evaluate(() => window.notificationFixture.emit(0));
  expect(await page.evaluate(() => window.notificationFixture.delivered())).toHaveLength(7);

  // Synthetic activity and terminal device replies cannot claim human attention.
  await first.locator('textarea').dispatchEvent('keydown', { key: 'a' });
  await page.evaluate(() => window.notificationFixture.emit(0));
  expect(await page.evaluate(() => window.notificationFixture.delivered())).toHaveLength(8);
  expect(errors).toEqual([]);
});

test('native notification clicks activate hidden tabs and open missing sessions across projects', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(`${origin}/api/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/file'))
      return route.fulfill({
        json: {
          path: 'notes.md',
          content: '# Notes',
          binary: false,
          size: 7,
          mtime_ms: 1,
        },
      });
    if (path.endsWith('/ports')) return route.fulfill({ json: { ports: [] } });
    if (path.endsWith('/env')) return route.fulfill({ json: { entries: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${origin}/e2e/fixtures/desktop-notifications.html?workspace`);
  const terminal = (index: number) =>
    page.locator(`[data-notification-session="${sessionIds[index]}"]`);
  await expect(terminal(0)).toBeVisible();
  const notes = page.getByRole('button', { name: /^notes.md/ });
  await notes.click({ position: { x: 3, y: 8 } });
  await expect(terminal(0)).not.toBeVisible();
  await expect(page.getByLabel('Route')).toHaveText(`/project/1000000001/session/${sessionIds[0]}`);
  // No in-memory delivery callback exists: this is the native destination path,
  // including after a renderer reload. The URL's session already matches.
  await page.evaluate(() => window.notificationFixture.click(0));
  await expect(terminal(0)).toBeVisible();
  // Repeated clicks must activate it again without forcing it over file tabs.
  await notes.click({ position: { x: 3, y: 8 } });
  await expect(terminal(0)).not.toBeVisible();
  await page.evaluate(() => window.notificationFixture.click(0));
  await expect(terminal(0)).toBeVisible();
  await expect(
    page.locator('[aria-roledescription="draggable"]').filter({ hasText: 'Conversation 1' }),
  ).toHaveCount(1);
  await page.evaluate(() => window.notificationFixture.click(1));
  await expect(terminal(1)).toBeVisible();
  await expect(terminal(0)).not.toBeVisible();
  // This session has never had a tab in either project layout.
  await page.evaluate(() => window.notificationFixture.click(2));
  await expect(terminal(2)).toBeVisible();
  await expect(page.getByLabel('Route')).toHaveText(`/project/1000000002/session/${sessionIds[2]}`);
  await page.getByRole('button', { name: 'Fixture home' }).click();
  await expect(page.getByText('Fixture dashboard')).toBeVisible();
  await page.evaluate(() => window.notificationFixture.click(0));
  await expect(terminal(0)).toBeVisible();
  expect(errors).toEqual([]);
});
