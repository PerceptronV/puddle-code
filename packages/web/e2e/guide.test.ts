import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import {
  REMOTE_PROTOCOL_VERSION,
  remoteHostsSchema,
  remoteLoginStateSchema,
  remoteServiceInfoSchema,
} from '@puddle/shared';

// Documentation and sign-in links need no daemon, connector or real account.
const service = 'https://relay.example.test';
let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: fileURLToPath(new URL('../vite.build.config.ts', import.meta.url)),
    define: { 'import.meta.env.VITE_PUDDLE_REMOTE_SERVICE': JSON.stringify(service) },
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Missing Guide test server port');
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await server?.close();
});

test('Guide loads directly without authentication or relay access on mobile and desktop', async ({
  page,
}, testInfo) => {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(`${service}/**`, async (route) => {
    requests.push(route.request().url());
    await route.abort();
  });
  for (const [width, theme] of [
    [390, 'light'],
    [1200, 'dark'],
  ] as const) {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`${origin}/guide${width === 390 ? '/' : ''}`);
    await expect(page).toHaveTitle('Guide · Puddle');
    await expect(page.getByRole('heading', { name: 'Puddle Guide', exact: true })).toBeVisible();
    await expect(page.locator('pre').filter({ hasText: 'curl -fsSL' }).first()).toHaveText(
      `curl -fsSL ${origin}/install.sh | sh\n`,
    );
    await expect(page.getByRole('button', { name: /Continue with/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`guide-${theme}.png`) });
    const contents = page.locator('article a[href^="#"]');
    expect(await contents.count()).toBeGreaterThan(0);
    for (const link of await contents.all()) {
      const href = await link.getAttribute('href');
      await expect(page.locator(`article ${href}`)).toHaveCount(1);
    }
    await page.getByRole('link', { name: 'CLI installation', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/guide${width === 390 ? '/' : ''}#cli-installation`);
    await expect(
      page.getByRole('heading', { name: 'CLI installation', exact: true }),
    ).toBeInViewport();
    const note = page.locator('li .markdown-alert-note');
    await expect(note.locator('.markdown-alert-title')).toHaveText('Note');
    await expect(note).toContainText('Linux needs glibc 2.28 or newer');
    await expect(note.locator('pre')).toContainText('export PATH="$HOME/.local/bin:$PATH"');
    await expect(page.locator('article')).not.toContainText('[!NOTE]');
    await note.screenshot({ path: testInfo.outputPath(`guide-note-${theme}.png`) });
  }
  await page.goto(`${origin}/faq/?source=old-link#cli-installation`);
  await expect(page).toHaveURL(`${origin}/guide?source=old-link#cli-installation`);
  await expect(page.getByRole('heading', { name: 'Puddle Guide', exact: true })).toBeVisible();
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});

test('setup link appears below sign-in buttons and above the signed-in host list', async ({
  page,
}) => {
  let signedIn = false;
  await page.route(`${service}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/remote/config')
      return route.fulfill({
        json: remoteServiceInfoSchema.parse({
          providers: ['google', 'github'],
          protocol: REMOTE_PROTOCOL_VERSION,
        }),
      });
    if (path === '/remote/me')
      return route.fulfill({
        json: remoteLoginStateSchema.parse({
          user: signedIn
            ? {
                id: 'guide-reader',
                name: 'Reader',
                email: 'reader@example.test',
                emailVerified: true,
                twoFactorEnabled: false,
              }
            : null,
          mfaRequired: false,
        }),
      });
    if (path === '/remote/hosts')
      return route.fulfill({
        json: remoteHostsSchema.parse([
          { id: '00000000-0000-4000-8000-000000000001', label: 'Test host', online: false },
        ]),
      });
    return route.abort();
  });
  await page.goto(origin);
  const help = page.getByText('For setup or upgrade instructions, see Guide.', { exact: true });
  await expect(help).toBeVisible();
  const button = await page.getByRole('button', { name: 'Continue with GitHub' }).boundingBox();
  expect((await help.boundingBox())!.y).toBeGreaterThan(button!.y + button!.height);
  await page.getByRole('link', { name: 'Guide', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/guide`);
  await expect(page.getByRole('heading', { name: 'Puddle Guide', exact: true })).toBeVisible();
  signedIn = true;
  await page.getByRole('link', { name: 'Back to Puddle' }).click();
  await expect(help).toBeVisible();
  await expect(page.getByText('Test host', { exact: true })).toBeVisible();
  const hint = (await help.boundingBox())!;
  expect((await page.getByText('Test host', { exact: true }).boundingBox())!.y).toBeGreaterThan(
    hint.y + hint.height,
  );
});
