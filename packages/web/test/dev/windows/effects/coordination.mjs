/* global window, performance, Response */
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

const observers = (page) =>
  page.evaluate(async () => {
    const { queryClient } = await import(
      performance
        .getEntriesByType('resource')
        .find((entry) => new URL(entry.name).pathname === '/src/lib/queries/client.ts')?.name ??
        '/src/lib/queries/client.ts'
    );
    return queryClient
      .getQueryCache()
      .findAll({ queryKey: ['frontend-host-updates'] })
      .reduce((sum, query) => sum + query.getObserversCount(), 0);
  });
const counts = (page) =>
  page.evaluate(() => ({
    sound: window.notificationSounds,
    notices: window.notificationDeliveries.length,
  }));

/** Real shell election and real notification hooks, without a daemon or OS notification. */
export async function checkWindowEffects({ source, target, profileId, focused }) {
  for (const page of [source, target])
    await page.evaluate(async () => {
      const moduleUrl = (path) =>
        performance
          .getEntriesByType('resource')
          .find((entry) => new URL(entry.name).pathname === path)?.name ?? path;
      const { browserTransport } = await import(
        moduleUrl('/src/lib/transport/browser-transport.ts')
      );
      const { queryClient } = await import(moduleUrl('/src/lib/queries/client.ts'));
      const { statusFixture, reviewFixture } = await import('/test/host-updates/fixtures.ts');
      const status = statusFixture();
      delete status.catalogue;
      status.result = reviewFixture();
      status.result.operation.phase = 'checking';
      const transport = browserTransport();
      const original = transport.request.bind(transport);
      window.hostUpdateReads = 0;
      transport.request = (method, path, ...rest) => {
        if (method === 'GET' && path.startsWith('/api/host/updates')) {
          window.hostUpdateReads++;
          return Promise.resolve(Response.json(status));
        }
        return original(method, path, ...rest);
      };
      queryClient.setQueryData(['host-update-access', transport.scope, transport.generation], true);
    });
  await expect.poll(() => observers(source)).toBeGreaterThan(0);
  await expect.poll(() => observers(target)).toBe(0);
  await expect.poll(() => source.evaluate(() => window.hostUpdateReads)).toBeGreaterThan(1);
  assert.equal(await target.evaluate(() => window.hostUpdateReads), 0);
  const offer = 'Puddle 0.4.999 is downloaded and ready.';
  await expect(source.getByText(offer, { exact: true })).toBeVisible();
  await expect(target.getByText(offer, { exact: true })).toHaveCount(0);
  await source.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .find(
        (entry) => new URL(entry.name).pathname === '/src/features/windows/window-context.tsx',
      )?.name;
    const { suspendDesktopContent } = await import(url);
    suspendDesktopContent(true);
    suspendDesktopContent(false);
  });
  await expect(source.getByText(offer, { exact: true })).toBeVisible();
  await expect.poll(() => source.evaluate(() => window.desktopUpdateObservers)).toBe(1);
  const session = await target.evaluate(
    async () => (await import('/src/dev/preview/data.ts')).sessions[0].id,
  );
  for (const page of [source, target])
    await page.evaluate(async (profileId) => {
      const { queryClient } = await import(
        performance
          .getEntriesByType('resource')
          .find((entry) => new URL(entry.name).pathname === '/src/lib/queries/client.ts')?.name ??
          '/src/lib/queries/client.ts'
      );
      queryClient.setQueryData(['profile-settings', profileId], {
        notifications: { desktop: true, sound: true, when_focused: true, muted_projects: [] },
      });
    }, profileId);
  await target.bringToFront();
  await target.evaluate(() => window.windowRequest('effects-focus'));
  const emit = async (id) =>
    Promise.all(
      [source, target].map((page) =>
        page.evaluate(
          async ({ id, session }) => {
            const { wsManager } = await import(
              performance
                .getEntriesByType('resource')
                .find((entry) => new URL(entry.name).pathname === '/src/lib/transport/ws.ts')
                ?.name ?? '/src/lib/transport/ws.ts'
            );
            wsManager.handle({ t: 'agent-notification', id, session, reason: 'waiting_input' });
          },
          { id, session },
        ),
      ),
    );
  await emit('00000000-0000-4000-8000-000000000001');
  await expect.poll(() => counts(target)).toEqual({ sound: 1, notices: 1 });
  assert.deepEqual(await counts(source), { sound: 0, notices: 0 });
  await source.evaluate(() => window.windowRequest('effects-focus'));
  await emit('00000000-0000-4000-8000-000000000001');
  await emit('00000000-0000-4000-8000-000000000002');
  await expect.poll(() => counts(source)).toEqual({ sound: 1, notices: 1 });
  assert.deepEqual(await counts(target), { sound: 1, notices: 1 });
  await target.bringToFront();
  await target.evaluate(async (profileId) => {
    await window.windowRequest('effects-focus');
    const { queryClient } = await import(
      performance
        .getEntriesByType('resource')
        .find((entry) => new URL(entry.name).pathname === '/src/lib/queries/client.ts')?.name ??
        '/src/lib/queries/client.ts'
    );
    queryClient.setQueryData(['profile-settings', profileId], {
      notifications: { desktop: true, sound: true, when_focused: false, muted_projects: [] },
    });
  }, profileId);
  await target.locator('[data-notification-session]').first().click();
  await emit('00000000-0000-4000-8000-000000000003');
  await expect.poll(() => counts(target)).toEqual({ sound: 2, notices: 1 });
  assert.deepEqual(await counts(source), { sound: 1, notices: 1 });
  const previousFocus = focused();
  await source.evaluate(() => {
    const notice = window.notificationDeliveries[0];
    window.notificationClick(notice.id, notice.target);
  });
  await expect.poll(focused).toBe(previousFocus + 1);
  await expect(source.locator('.xterm')).toHaveCount(0);
  await expect(target.locator('.xterm')).toHaveCount(1);
  console.log(
    'One native notification and sound per host event; focus changes retain consumed ids, recent terminal interaction suppresses desktop delivery, and clicks focus the existing detached session.',
  );
}

export async function checkDetachedEffectOwner(target) {
  await expect.poll(() => observers(target)).toBeGreaterThan(0);
  await expect.poll(() => target.evaluate(() => window.hostUpdateReads)).toBeGreaterThan(0);
  await expect(
    target.getByText('Puddle 0.4.999 is downloaded and ready.', { exact: true }),
  ).toBeVisible();
  await expect.poll(() => target.evaluate(() => window.desktopUpdateObservers)).toBe(1);
  console.log(
    'Detached window takes over automatic host-update observation after the host closes.',
  );
}
