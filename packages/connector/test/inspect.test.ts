const profile = 'a'.repeat(10);
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import { inspectConnector } from '../src/inspect.js';
import { createIdentity, identityPeer } from '@puddle/remote-transport';

it('reports unconfigured hosts without creating remote state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-remote-inspect-'));
  try {
    writeFileSync(join(home, 'supervisor'), 'launchd');
    expect(await inspectConnector(home, profile)).toMatchObject({
      availability: 'ready',
      configured: false,
      supervisor: 'launchd',
      devices: [],
    });
    expect(existsSync(join(home, 'remote', 'profiles', profile))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it('projects offline host status without returning routing credentials or private configuration', async () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-remote-inspect-'));
  try {
    atomicPrivateJson(join(home, 'remote', 'profiles', profile, 'config.json'), {
      enabled: false,
      host: crypto.randomUUID(),
      account: 'private-account',
      credential: 'b'.repeat(64),
      service: 'https://relay.example.test',
      app: 'https://app.example.test',
    });
    const identity = await createIdentity();
    atomicPrivateJson(join(home, 'remote', 'profiles', profile, 'identity.json'), [...identity]);
    const status = await inspectConnector(home, profile);
    expect(status).toMatchObject({
      configured: true,
      enabled: false,
      connected: false,
      service: 'https://relay.example.test',
    });
    expect(JSON.stringify(status)).not.toContain('private-account');
    expect(JSON.stringify(status)).not.toContain('b'.repeat(64));
    expect(status.peer).toBe(identityPeer(identity));
    expect(JSON.stringify(status)).not.toContain(JSON.stringify([...identity]));
    expect(existsSync(join(home, 'remote', 'profiles', profile, 'devices.db'))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
