const profile = 'a'.repeat(10);
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { atomicPrivateJson, readPrivateJson } from '@puddle/shared/node';
import {
  connectorConfigSchema,
  remoteAdminRequestSchema,
  remoteIdentitySchema,
} from '@puddle/shared';
import { createIdentity, identityPeer } from '@puddle/remote-transport';
import { administrativeRequest, configureConnector, resetConnectorIdentity } from '../src/admin.js';
import { DeviceStore } from '../src/devices.js';

it('disables and revokes offline; identity recovery cannot be invoked remotely', async () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-offline-recovery-'));
  const directory = join(home, 'remote', 'profiles', profile);
  try {
    atomicPrivateJson(join(directory, 'config.json'), {
      enabled: true,
      host: crypto.randomUUID(),
      account: 'owner',
      credential: 'a'.repeat(64),
      service: 'https://relay.example.test',
      app: 'https://app.example.test',
    });
    const identity = await createIdentity();
    atomicPrivateJson(join(directory, 'identity.json'), [...identity]);
    let devices = new DeviceStore(directory);
    const device = devices.enrol(
      devices.invite().invitation,
      identityPeer(await createIdentity()),
      'owner',
      'Phone',
    );
    devices.approve(device.id);
    const unused = devices.invite();
    devices.close();
    await administrativeRequest(home, { t: 'disable' }, profile);
    expect(
      connectorConfigSchema.parse(readPrivateJson(join(directory, 'config.json'))).enabled,
    ).toBe(false);
    await resetConnectorIdentity(home, profile);
    expect(
      identityPeer(
        Uint8Array.from(
          remoteIdentitySchema.parse(readPrivateJson(join(directory, 'identity.json'))),
        ),
      ),
    ).not.toBe(identityPeer(identity));
    devices = new DeviceStore(directory);
    expect(devices.valid(device.id, device.peer, 'owner')).toBe(false);
    expect(() =>
      devices.enrol(unused.invitation, device.peer, 'owner', 'Old invitation'),
    ).toThrow();
    devices.close();
    expect(remoteAdminRequestSchema.safeParse({ t: 'reset' }).success).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it('rejects an oversized registration response before persisting host configuration', async () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-registration-limit-'));
  let cancelled = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(65 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    ),
  );
  try {
    await expect(
      configureConnector(
        home,
        {
          service: 'https://relay.example.test',
          app: 'https://app.example.test',
          code: 'a'.repeat(64),
          managed: false,
        },
        profile,
      ),
    ).rejects.toThrow('response is too large');
    expect(cancelled).toBe(true);
    expect(existsSync(join(home, 'remote', 'profiles', profile, 'config.json'))).toBe(false);
  } finally {
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
  }
});

it('requires fresh device approval after registering the host in a new service context', async () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-reregister-'));
  const directory = join(home, 'remote', 'profiles', profile);
  const devices = new DeviceStore(directory);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        host: crypto.randomUUID(),
        account: 'new-owner',
        credential: 'b'.repeat(64),
      }),
    ),
  );
  try {
    const peer = identityPeer(await createIdentity());
    const device = devices.enrol(devices.invite().invitation, peer, 'owner', 'Phone');
    devices.approve(device.id);
    const unused = devices.invite();
    await configureConnector(
      home,
      {
        service: 'https://relay.example.test',
        app: 'https://app.example.test',
        code: 'a'.repeat(64),
        managed: false,
      },
      profile,
    );
    expect(devices.valid(device.id, peer, 'owner')).toBe(false);
    expect(() => devices.enrol(unused.invitation, peer, 'owner', 'Old invitation')).toThrow();
  } finally {
    vi.unstubAllGlobals();
    devices.close();
    rmSync(home, { recursive: true, force: true });
  }
});
