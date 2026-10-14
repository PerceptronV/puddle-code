import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pushEndpointSchema } from '@puddle/shared';
import { ServiceStore } from '../src/store.js';
import { PushDelivery, installPushRoutes } from '../src/notifications.js';
import type { RemoteConfig } from '../src/config.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-push-service-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const store = new ServiceStore(home);
  cleanup.push(() => store.close());
  const config: RemoteConfig = {
    home,
    service: 'https://service.example.test',
    app: 'https://app.example.test',
    secret: 'test-only'.repeat(8),
    address: '127.0.0.1',
    port: 0,
  };
  const send = vi.fn(async () => ({ statusCode: 201, body: '', headers: {} }));
  const push = new PushDelivery(store, config, send);
  const registration = store.redeem(store.register('account', 'Host').code);
  const host = store.host(registration.host)!;
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/test',
    keys: { p256dh: push.publicKey, auth: Buffer.alloc(16, 1).toString('base64url') },
  };
  return { store, push, send, host, registration, subscription };
}

describe('generic Web Push delivery', () => {
  it('binds registrations to an authenticated host/device and sends no host content', async () => {
    const f = fixture();
    const device = randomUUID();
    f.push.register(f.host, device, f.subscription);
    const id = randomUUID();
    expect(await f.push.notify(f.host, [randomUUID()], id)).toEqual({ accepted: 0, failed: 0 });
    expect(f.send).not.toHaveBeenCalled();
    expect(await f.push.notify(f.host, [device], id)).toEqual({ accepted: 1, failed: 0 });
    await f.push.notify(f.host, [device], id);
    expect(f.send).toHaveBeenCalledTimes(1);
    const call = f.send.mock.calls[0] as unknown as [
      unknown,
      string,
      { TTL: number; timeout: number },
    ];
    expect(JSON.parse(call[1])).toEqual({ id, host: f.host.id });
    expect(call[2]).toMatchObject({ TTL: 120, timeout: 5000 });
    f.push.register(f.host, device, null);
    await f.push.notify(f.host, [device], randomUUID());
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('removes expired vendor subscriptions and cleans up host deletion', async () => {
    const f = fixture();
    const device = randomUUID();
    f.push.register(f.host, device, f.subscription);
    f.send.mockRejectedValueOnce(Object.assign(new Error('Gone'), { statusCode: 410 }));
    expect(await f.push.notify(f.host, [device], randomUUID())).toEqual({ accepted: 0, failed: 1 });
    await f.push.notify(f.host, [device], randomUUID());
    expect(f.send).toHaveBeenCalledTimes(1);
    f.push.register(f.host, device, f.subscription);
    f.store.remove(f.host.id, 'another-account');
    expect(f.store.db.prepare('SELECT count(*) AS n FROM push_subscriptions').get()).toEqual({
      n: 1,
    });
    f.store.remove(f.host.id, f.host.account);
    expect(f.store.db.prepare('SELECT count(*) AS n FROM push_subscriptions').get()).toEqual({
      n: 0,
    });
  });

  it('refuses browser credentials, invalid machine credentials and unsupported endpoints', async () => {
    const f = fixture();
    const app = new Hono();
    installPushRoutes(app, f.store, f.push);
    const body = {
      credential: f.registration.credential,
      device: randomUUID(),
      subscription: f.subscription,
    };
    const request = (value: unknown, headers = {}) =>
      app.request('http://service/remote/push/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(value),
      });
    expect((await request(body, { origin: 'https://app.example.test' })).status).toBe(403);
    expect((await request(body, { cookie: 'session=test' })).status).toBe(403);
    expect((await request({ ...body, credential: 'a'.repeat(64) })).status).toBe(403);
    expect(
      (
        await request({
          ...body,
          subscription: { ...f.subscription, endpoint: 'https://127.0.0.1/private' },
        })
      ).status,
    ).toBe(400);
    expect((await request(body)).status).toBe(204);
  });

  it.each([
    'not-a-url',
    'http://fcm.googleapis.com/send',
    'https://fcm.googleapis.com:8443/send',
    'https://fcm.googleapis.com.evil.test/send',
    'https://user@fcm.googleapis.com/send',
    'https://localhost/send',
    'https://web.push.apple.com/#secret',
  ])('refuses SSRF endpoint %s', (url) => {
    expect(pushEndpointSchema.safeParse(url).success).toBe(false);
  });
});
