import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorNotifications } from '../src/notifications.js';
import { DeviceStore } from '../src/devices.js';
import { permittedRequest } from '../src/policy.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'puddle-push-connector-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const devices = new DeviceStore(directory);
  cleanup.push(() => devices.close());
  const device = devices.enrol(devices.invite().invitation, 'a'.repeat(64), 'account', 'Browser');
  devices.approve(device.id);
  let enabled = true;
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const send = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      path: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(null, { status: 204 });
  });
  const config = {
    service: 'https://service.example.test',
    app: 'https://app.example.test',
    host: randomUUID(),
    account: 'account',
    credential: 'c'.repeat(64),
    enabled: true,
  };
  const notifications = new ConnectorNotifications(config, devices, () => enabled, send);
  const subscription = {
    endpoint: 'https://web.push.apple.com/test',
    keys: { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) },
  };
  return {
    devices,
    device,
    notifications,
    calls,
    send,
    subscription,
    config,
    disable: () => {
      enabled = false;
    },
  };
}

describe('approved-device push subscriptions', () => {
  it('keeps preview keys on the host, encrypts for the exact device, and removes keys on revocation', async () => {
    const f = fixture();
    const key = { id: randomUUID(), secret: 'd'.repeat(64) };
    await f.notifications.update(
      f.device.id,
      { subscription: f.subscription, preview_key: key },
      new AbortController().signal,
      () => true,
    );
    expect(f.calls[0]!.body).toEqual({
      credential: f.config.credential,
      device: f.device.id,
      subscription: f.subscription,
    });
    const content = {
      title: 'Conversation title',
      body: 'The changes passed verification.',
      project: '0123456789',
      session: randomUUID(),
    };
    await f.notifications.notify(randomUUID(), content);
    expect(f.calls[1]!.body.preview).toMatchObject({ key: key.id });
    const wire = JSON.stringify(f.calls);
    expect(wire).not.toContain(key.secret);
    for (const value of Object.values(content)) expect(wire).not.toContain(value);
    expect(f.devices.notificationKey(f.device.id)).toEqual(key);
    f.devices.revoke(f.device.id);
    expect(f.devices.notificationKey(f.device.id)).toBeUndefined();
    await f.notifications.notify(randomUUID(), content);
    expect(f.calls).toHaveLength(2);
  });
  it('sends only to an opted-in approved device and stops on revocation or disable', async () => {
    const f = fixture();
    await f.notifications.notify(randomUUID());
    expect(f.calls).toHaveLength(0);
    await f.notifications.update(
      f.device.id,
      { subscription: f.subscription },
      new AbortController().signal,
      () => true,
    );
    const id = randomUUID();
    await f.notifications.notify(id);
    expect(f.calls[1]!.body).toEqual({ credential: 'c'.repeat(64), devices: [f.device.id], id });
    f.devices.revoke(f.device.id);
    await f.notifications.notify(randomUUID());
    expect(f.calls).toHaveLength(2);
    f.disable();
    await f.notifications.notify(randomUUID());
    expect(f.calls).toHaveLength(2);
  });

  it('does not keep a registration when browser participation expires during the write', async () => {
    const f = fixture();
    let current = true;
    f.send.mockImplementationOnce(async () => {
      current = false;
      return new Response(null, { status: 204 });
    });
    await expect(
      f.notifications.update(
        f.device.id,
        { subscription: f.subscription },
        new AbortController().signal,
        () => current,
      ),
    ).rejects.toThrow('expired');
    expect(f.devices.notificationDevices()).toEqual([]);
    expect(f.calls[0]?.body).toMatchObject({ device: f.device.id, subscription: null });
  });

  it('permits only the exact connector operations and rejects caller-selected device identities', () => {
    const base = {
      t: 'request' as const,
      id: randomUUID(),
      method: 'POST' as const,
      path: '/api/notifications/push',
    };
    expect(permittedRequest({ ...base, body: { subscription: null } }).notification).toEqual({
      subscription: null,
    });
    expect(() =>
      permittedRequest({ ...base, body: { subscription: null, device: randomUUID() } }),
    ).toThrow();
    for (const path of [
      '/api/notifications',
      '/api/notifications/send',
      '/api/notifications/push?device=test',
    ])
      expect(() => permittedRequest({ ...base, path })).toThrow();
    expect(() => permittedRequest({ ...base, method: 'GET' })).toThrow();
    expect(() =>
      permittedRequest({ ...base, path: '/api/notifications/test', body: { id: randomUUID() } }),
    ).toThrow();
  });
});

it('handles notification registration inside a participating host lease without forwarding a daemon request', async () => {
  const { RemoteUpstream } = await import('../src/upstream.js');
  const send = vi.fn(async () => {});
  const update = vi.fn(async () => ({ enabled: false }));
  const upstream = new RemoteUpstream(
    '/tmp/unused-notification-test',
    { send },
    () => true,
    vi.fn(),
    '0123456789',
    { update, test: vi.fn(async () => ({})) },
  );
  let valid = true;
  const release = vi.fn();
  vi.spyOn(upstream.authority, 'resource').mockReturnValue({
    id: 'resource',
    release,
    valid: () => valid,
  });
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  try {
    await upstream.request({
      t: 'request',
      id: randomUUID(),
      method: 'POST',
      path: '/api/notifications/push',
      body: { subscription: null },
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ status: 200, body: { enabled: false } }),
    );
    expect(fetcher).not.toHaveBeenCalled();
    valid = false;
    await upstream.request({
      t: 'request',
      id: randomUUID(),
      method: 'POST',
      path: '/api/notifications/push',
      body: { subscription: null },
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(2);
  } finally {
    upstream.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
