import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { connectorLocalRequestSchema, remoteAdminRequestSchema } from '@puddle/shared';
import { atomicPrivateJson, ipcPath, listenPrivate } from '@puddle/shared/node';
import { createIdentity, identityPeer } from '@puddle/remote-transport';
import { administrativeRequest } from '../../src/admin.js';
import { DeviceStore } from '../../src/devices.js';
import { startConnector } from '../../src/runtime.js';

const profile = 'a'.repeat(10);
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-maintenance-admin-'));
  const directory = join(home, 'remote/profiles', profile);
  const config = {
    enabled: false,
    host: randomUUID(),
    account: 'owner',
    credential: 'a'.repeat(64),
    service: 'https://relay.example.test',
    app: 'https://app.example.test',
  };
  atomicPrivateJson(join(directory, 'config.json'), config);
  atomicPrivateJson(join(directory, 'identity.json'), [...(await createIdentity())]);
  const socket = ipcPath(home, `remote-${profile}`);
  const devices = new DeviceStore(directory);
  cleanups.push(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(dirname(socket), { recursive: true, force: true });
  });
  cleanups.push(() => devices.close());
  const peer = identityPeer(await createIdentity());
  const device = devices.enrol(devices.invite().invitation, peer, 'owner', 'Phone');
  devices.approve(device.id);
  return { home, directory, config, socket, devices, peer, device };
}

it.each([false, true])(
  'accepts a host-local grant with live connector=%s, never through paired-browser administration',
  async (live) => {
    const f = await fixture();
    if (live) {
      const connector = await startConnector(f.home, profile);
      cleanups.push(() => connector.close());
    }
    const request = { t: 'maintenance', id: f.device.id, enabled: true } as const;
    expect(connectorLocalRequestSchema.safeParse(request).success).toBe(true);
    expect(remoteAdminRequestSchema.safeParse(request).success).toBe(false);
    expect(
      remoteAdminRequestSchema.safeParse({ t: 'approve', id: f.device.id, maintenance: true })
        .success,
    ).toBe(false);
    expect(f.devices.maintenanceClaim(f.device.id, f.peer, 'owner', f.config.host)).toBeNull();
    const result = await administrativeRequest(f.home, request, profile);
    expect(result.devices?.find((row) => row.id === f.device.id)?.maintenance).toBe(true);
    const claim = f.devices.maintenanceClaim(f.device.id, f.peer, 'owner', f.config.host);
    expect(claim).not.toBeNull();
    await administrativeRequest(f.home, request, profile);
    expect(f.devices.maintenanceClaim(f.device.id, f.peer, 'owner', f.config.host)).toEqual(claim);
    await administrativeRequest(f.home, { ...request, enabled: false }, profile);
    expect(f.devices.maintenanceClaim(f.device.id, f.peer, 'owner', f.config.host)).toBeNull();
  },
);

it('does not grant offline after an uncertain live reply', async () => {
  const f = await fixture();
  const server = await listenPrivate(f.socket, (socket) => {
    socket.once('data', () => socket.end('invalid reply\n'));
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await expect(
    administrativeRequest(f.home, { t: 'maintenance', id: f.device.id, enabled: true }, profile),
  ).rejects.toThrow();
  expect(f.devices.maintenanceClaim(f.device.id, f.peer, 'owner', f.config.host)).toBeNull();
});

it('refuses a delayed grant through an old connector after the registration changes', async () => {
  const f = await fixture();
  const connector = await startConnector(f.home, profile);
  cleanups.push(() => connector.close());
  atomicPrivateJson(join(f.directory, 'config.json'), { ...f.config, host: randomUUID() });
  const result = await administrativeRequest(
    f.home,
    { t: 'maintenance', id: f.device.id, enabled: true },
    profile,
  );
  expect(result.error).toBeDefined();
  expect(f.devices.maintenanceClaim(f.device.id, f.peer, 'owner', f.config.host)).toBeNull();
});
