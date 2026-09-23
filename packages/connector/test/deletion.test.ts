const profile = 'a'.repeat(10);
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { atomicPrivateJson, ipcPath, listenPrivate } from '@puddle/shared/node';
import { createIdentity, identityPeer } from '@puddle/remote-transport';
import { administrativeRequest, configureConnector } from '../src/admin.js';
import { DeviceStore } from '../src/devices.js';
import { inspectConnector } from '../src/inspect.js';
import { startConnector } from '../src/runtime.js';
import {
  flushRegistrationCleanup,
  hasRegistrationCleanup,
  startRegistrationCleanup,
} from '../src/registration-cleanup.js';

it.each([false, true])('deletes registration with a live connector: %s', async (live) => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-delete-registration-'));
  const directory = join(home, 'remote', 'profiles', profile);
  const configPath = join(directory, 'config.json');
  const socketPath = ipcPath(home, `remote-${profile}`);
  let connector: Awaited<ReturnType<typeof startConnector>> | undefined;
  const fetch = vi.fn(async () => {
    throw new Error('Relay offline');
  });
  vi.stubGlobal('fetch', fetch);
  try {
    atomicPrivateJson(configPath, {
      enabled: !live, // The offline case also works for an enabled but stopped connector.
      host: crypto.randomUUID(),
      account: 'owner',
      credential: 'a'.repeat(64),
      service: 'https://relay.example.test',
      app: 'https://app.example.test',
    });
    const identity = [...(await createIdentity())];
    atomicPrivateJson(join(directory, 'identity.json'), identity);
    writeFileSync(join(home, 'agent-state'), 'work continues');
    const devices = new DeviceStore(directory);
    try {
      const peer = identityPeer(await createIdentity());
      const device = devices.enrol(devices.invite().invitation, peer, 'owner', 'Phone');
      devices.approve(device.id);
      const pending = devices.enrol(devices.invite().invitation, peer, 'owner', 'Tablet');
      const unused = devices.invite();
      if (live) connector = await startConnector(home, profile);
      expect(await administrativeRequest(home, { t: 'delete_registration' }, profile)).toEqual({
        enabled: false,
        connected: false,
      });
      expect(existsSync(configPath)).toBe(false);
      expect(hasRegistrationCleanup(directory)).toBe(true);
      expect(devices.valid(device.id, peer, 'owner')).toBe(false);
      expect(devices.list().every((row) => row.status === 'revoked')).toBe(true);
      expect(() => devices.enrol(unused.invitation, peer, 'owner', 'Old invitation')).toThrow();
      expect(await inspectConnector(home, profile)).toMatchObject({
        configured: false,
        enabled: false,
        devices: [],
      });
      await expect(configureConnector(home, { managed: false }, profile)).rejects.toThrow(
        'First registration requires',
      );
      if (live) {
        // A delayed old request cannot recreate the deleted registration or restore an approval.
        expect((await administrativeRequest(home, { t: 'disable' }, profile)).error).toBeDefined();
        expect(
          (await administrativeRequest(home, { t: 'approve', id: pending.id }, profile)).error,
        ).toBeDefined();
        expect(existsSync(configPath)).toBe(false);
      }
      await administrativeRequest(home, { t: 'delete_registration' }, profile);
      expect(JSON.parse(readFileSync(join(directory, 'identity.json'), 'utf8'))).toEqual(identity);
      expect(readFileSync(join(home, 'agent-state'), 'utf8')).toBe('work continues');
      // A later supervisor start can finish removal without a saved configuration.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(null, { status: 204 })),
      );
      const cleanup = startRegistrationCleanup(directory, true);
      try {
        await vi.waitFor(() => expect(hasRegistrationCleanup(directory)).toBe(false));
      } finally {
        await cleanup.close();
      }
      await flushRegistrationCleanup(directory);
      expect(existsSync(configPath)).toBe(false);
    } finally {
      devices.close();
    }
  } finally {
    await connector?.close();
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
    rmSync(socketPath, { force: true });
  }
});

it('does not fall back to deleting files after an uncertain live IPC response', async () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-delete-uncertain-'));
  const path = join(home, 'remote', 'profiles', profile, 'config.json');
  atomicPrivateJson(path, { retained: true });
  const socketPath = ipcPath(home, `remote-${profile}`);
  const server = await listenPrivate(socketPath, (socket) => {
    socket.once('data', () => socket.end('invalid response\n'));
  });
  try {
    await expect(
      administrativeRequest(home, { t: 'delete_registration' }, profile),
    ).rejects.toThrow();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ retained: true });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
    rmSync(socketPath, { force: true });
  }
});
