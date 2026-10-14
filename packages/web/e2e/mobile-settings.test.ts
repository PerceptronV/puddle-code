import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import {
  PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION,
  remoteHostsSchema,
  remoteLoginStateSchema,
  remoteServiceInfoSchema,
} from '@puddle/shared';
import type { RemoteClient } from '../src/features/remote/client';

test.use({ hasTouch: true, isMobile: true });
const service = 'https://relay.example.test';
const account = 'notification-reader';
let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  // Real settings, styles and notification orchestration; no daemon or real push vendor.
  server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: fileURLToPath(new URL('../vite.build.config.ts', import.meta.url)),
    define: { 'import.meta.env.VITE_PUDDLE_REMOTE_SERVICE': JSON.stringify(service) },
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Missing settings fixture port');
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await server?.close();
});
test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ service, account }) => {
      localStorage.setItem(`puddle.push:${service}:${account}`, 'true');
      Object.defineProperty(window, 'Notification', { value: { permission: 'granted' } });
    },
    { service, account },
  );
  await page.route(`${service}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/remote/config')
      return route.fulfill({
        json: remoteServiceInfoSchema.parse({
          providers: ['github'],
          protocol: REMOTE_PROTOCOL_VERSION,
        }),
      });
    if (path === '/remote/me')
      return route.fulfill({
        json: remoteLoginStateSchema.parse({
          user: {
            id: account,
            name: 'Reader',
            email: 'reader.with.a.long.account.identifier@very-long-service-domain.example.test',
            emailVerified: true,
            twoFactorEnabled: true,
          },
          mfaRequired: false,
        }),
      });
    if (path === '/remote/hosts')
      return route.fulfill({
        json: remoteHostsSchema.parse([
          {
            id: '00000000-0000-4000-8000-000000000001',
            label: 'host-' + 'x'.repeat(70),
            online: false,
          },
        ]),
      });
    return route.abort();
  });
  await page.goto(origin);
  await page.getByRole('button', { name: 'Settings', exact: true }).tap();
});

async function attachHost(page: Page, outcome: 'shown' | 'failed' | 'stalled') {
  await page.evaluate(
    async ({ account, outcome, protocol }) => {
      const moduleUrl = new URL('/src/features/remote/push-notifications.ts', location.origin).href;
      const { watchPushNotifications } = await import(moduleUrl);
      Object.defineProperty(navigator.serviceWorker, 'register', {
        value: async () => ({
          active: { state: 'activated' },
          pushManager: {
            getSubscription: () =>
              outcome === 'stalled'
                ? new Promise(() => {})
                : Promise.resolve({
                    toJSON: () => ({
                      endpoint: 'https://web.push.apple.com/test',
                      keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) },
                    }),
                  }),
          },
        }),
      });
      const client = {
        state: 'connecting',
        generation: 'test-generation',
        scope: 'settings-fixture',
        host: { account },
        onState: () => () => {},
        request: async (_method: string, path: string) => {
          if (path === '/api/version')
            return Response.json({ version: 'test', protocol, remote_notifications: true });
          if (path === '/api/notifications/push') return Response.json({ enabled: true });
          if (path === '/api/notifications/test') {
            await new Promise((resolve) => setTimeout(resolve, 300));
            return Response.json({
              state: outcome,
              message:
                outcome === 'shown'
                  ? 'The push service accepted the notification. Check this device for its banner.'
                  : 'Push delivery failed. Disable and re-enable notifications on this device, then try again.',
            });
          }
          throw new Error('Unexpected fixture request');
        },
      } as unknown as RemoteClient;
      watchPushNotifications(client);
      client.state = 'ready';
    },
    { account, outcome, protocol: PROTOCOL_VERSION },
  );
}

test('settings fit a narrow phone with long account and host names and larger text', async ({
  page,
}, testInfo) => {
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.locator('summary').filter({ hasText: 'Account security' }).tap();
  await dialog.locator('summary').filter({ hasText: 'Manage pairings' }).tap();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '18px';
    });
    await expect
      .poll(() => dialog.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  }
  await dialog.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: testInfo.outputPath('mobile-settings.png') });
});

for (const outcome of ['shown', 'failed'] as const) {
  test(`an enabled notification test shows progress and its ${outcome} result beside the button`, async ({
    page,
  }) => {
    await attachHost(page, outcome);
    const section = page.getByRole('region', { name: 'Notifications' });
    await expect(section.getByRole('switch')).toBeChecked();
    await section.getByRole('button', { name: 'Send test', exact: true }).tap();
    await expect(section.getByRole('button', { name: 'Sending…', exact: true })).toBeVisible();
    await expect(section.getByRole('status')).toContainText('Sending the test');
    await expect(section.getByRole('status')).toContainText(
      outcome === 'shown' ? 'accepted' : 'failed',
    );
    await expect(section.getByRole('status')).toBeInViewport();
    await expect(section.getByRole('button', { name: 'Send test', exact: true })).toBeEnabled();
  });
}

test('a stalled browser subscription check produces a visible error and restores the test button', async ({
  page,
}) => {
  await attachHost(page, 'stalled');
  await page.clock.install();
  const section = page.getByRole('region', { name: 'Notifications' });
  await section.getByRole('button', { name: 'Send test', exact: true }).tap();
  await expect(section.getByRole('status')).toContainText('Checking this device');
  await page.clock.fastForward(10_001);
  await expect(section.getByRole('status')).toContainText('browser did not respond');
  await expect(section.getByRole('status')).toBeInViewport();
  await expect(section.getByRole('button', { name: 'Send test', exact: true })).toBeEnabled();
});
