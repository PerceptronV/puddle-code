import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';

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

for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']) {
  test(`copies ${mime} preview pixels at full size from its context menu`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await page.goto(`${origin}/e2e/fixtures/image-preview.html`);
    const body =
      mime === 'image/svg+xml'
        ? '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><path fill="red" d="M0 0h640v480H0z"/></svg>'
        : Buffer.from(
            await page.evaluate((type) => {
              const canvas = document.createElement('canvas');
              canvas.width = 640;
              canvas.height = 480;
              const context = canvas.getContext('2d')!;
              context.fillStyle = 'red';
              context.fillRect(0, 0, 640, 480);
              return canvas.toDataURL(type).split(',')[1]!;
            }, mime),
            'base64',
          );
    await page.route(`${origin}/api/worktrees/fixture/media?**`, (route) =>
      route.fulfill({ contentType: mime, body }),
    );
    await page.reload();
    const image = page.getByRole('img');
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(640);
    await page.evaluate(() => navigator.clipboard.writeText('Before image copy'));
    await image.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy image', exact: true }).click();
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          try {
            const items = await navigator.clipboard.read();
            const item = items.find((item) => item.types.includes('image/png'));
            if (!item) return null;
            const bitmap = await createImageBitmap(await item.getType('image/png'));
            const result = [bitmap.width, bitmap.height];
            bitmap.close();
            return result;
          } catch (error) {
            // The async PNG write can replace the clipboard between read and getType.
            if (error instanceof DOMException && error.name === 'InvalidStateError') return null;
            throw error;
          }
        }),
      )
      .toEqual([640, 480]);
  });
}

test('surfaces clipboard rejection from the image menu', async ({ page }) => {
  await page.route(`${origin}/api/worktrees/fixture/media?**`, (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path fill="red" d="M0 0h20v20H0z"/></svg>',
    }),
  );
  await page.goto(`${origin}/e2e/fixtures/image-preview.html`);
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'write', {
      value: () => Promise.reject(new Error('Clipboard blocked')),
    });
  });
  const image = page.getByRole('img');
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(20);
  await image.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy image', exact: true }).click();
  await expect(page.getByText('Clipboard blocked')).toBeVisible();
});
