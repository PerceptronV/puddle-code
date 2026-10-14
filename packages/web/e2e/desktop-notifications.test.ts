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
