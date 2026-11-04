import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type Socket } from 'node:net';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  REMOTE_POLICY,
  controlResponseSchema,
  type ControlResponse,
  type RemoteMaintenanceClaim,
  type HostMaintenanceReply,
} from '@puddle/shared';
import { atomicPrivateJson, ipcPath, jsonLines } from '@puddle/shared/node';
import { HostControlClient } from '@puddle/shared/node/host-control';
import { remoteMaintenanceAuthority } from '../../../src/security/remote/maintenance.js';
import { startHostControl, type HostMaintenanceControl } from '../../../src/security/control.js';
import { LeaseRegistry } from '../../../src/security/leases.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const profile = '0123456789';
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-maintenance-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, 'remote', 'profiles', profile);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const claim: RemoteMaintenanceClaim = {
    device: randomUUID(),
    peer: 'a'.repeat(64),
    account: 'account',
    host: randomUUID(),
    grant: randomUUID(),
  };
  const config = {
    account: claim.account,
    host: claim.host,
    credential: 'b'.repeat(64),
    service: 'https://relay.invalid',
    app: 'https://app.invalid',
    enabled: true,
  };
  const configFile = join(directory, 'config.json');
  atomicPrivateJson(configFile, config);
  const file = join(directory, 'devices.db');
  const db = new Database(file);
  chmodSync(file, 0o600);
  db.pragma('journal_mode = WAL');
  cleanups.push(() => {
    db.close();
  });
  db.exec(`CREATE TABLE devices(id TEXT PRIMARY KEY, peer TEXT, account TEXT, status TEXT, lastUsed INTEGER, expires INTEGER);
    CREATE TABLE maintenance_grants(device TEXT PRIMARY KEY, host TEXT, grant TEXT UNIQUE);
    PRAGMA user_version = 4;`);
  const now = Date.now();
  db.prepare('INSERT INTO devices VALUES (?, ?, ?, ?, ?, ?)').run(
    claim.device,
    claim.peer,
    claim.account,
    'approved',
    now,
    now + REMOTE_POLICY.absoluteMs,
  );
  db.prepare('INSERT INTO maintenance_grants VALUES (?, ?, ?)').run(
    claim.device,
    claim.host,
    claim.grant,
  );
  const check = (p = profile, c = claim) => remoteMaintenanceAuthority(home, p, c, now);
  return { home, directory, file, db, now, claim, config, configFile, check };
}

it('requires the exact current registration, device, Noise peer and unique grant without changing its database', () => {
  const f = fixture();
  const before = readFileSync(f.file);
  expect(f.check()).toBe(true);
  for (const change of [
    { device: randomUUID() },
    { peer: 'x'.repeat(64) },
    { account: 'other' },
    { host: randomUUID() },
    { grant: randomUUID() },
  ])
    expect(f.check(profile, { ...f.claim, ...change })).toBe(false);
  for (const p of ['abcdefghij', '../0123456789']) expect(f.check(p)).toBe(false);
  expect(readFileSync(f.file)).toEqual(before);
  atomicPrivateJson(f.configFile, { ...f.config, enabled: false });
  expect(f.check()).toBe(false);
  atomicPrivateJson(f.configFile, { ...f.config, account: 'replacement' });
  expect(f.check()).toBe(false);
  atomicPrivateJson(f.configFile, { ...f.config, host: randomUUID() });
  expect(f.check()).toBe(false);
});

it('sees expiry, idle expiry, pending/revoked devices and revoke/regrant immediately', () => {
  const f = fixture();
  for (const status of ['pending', 'revoked']) {
    f.db.prepare('UPDATE devices SET status = ?').run(status);
    expect(f.check()).toBe(false);
  }
  f.db.prepare('UPDATE devices SET status = ?, expires = ?').run('approved', f.now);
  expect(f.check()).toBe(false);
  f.db
    .prepare('UPDATE devices SET expires = ?, lastUsed = ?')
    .run(f.now + REMOTE_POLICY.absoluteMs, f.now - REMOTE_POLICY.idleMs);
  expect(f.check()).toBe(false);
  f.db.prepare('UPDATE devices SET lastUsed = ?').run(f.now);
  expect(f.check()).toBe(true);
  f.db.prepare('UPDATE devices SET expires = ?').run('not a timestamp');
  expect(f.check()).toBe(false);
  f.db
    .prepare('UPDATE devices SET expires = ?, lastUsed = ?')
    .run(f.now + REMOTE_POLICY.absoluteMs, 'not a timestamp');
  expect(f.check()).toBe(false);
  f.db.prepare('UPDATE devices SET lastUsed = ?').run(f.now);
  f.db.prepare('DELETE FROM maintenance_grants').run();
  expect(f.check()).toBe(false);
  f.db
    .prepare('INSERT INTO maintenance_grants VALUES (?, ?, ?)')
    .run(f.claim.device, f.claim.host, randomUUID());
  expect(f.check()).toBe(false);
});

it('fails closed for unknown schemas, unsafe private files and symlinks without migration', () => {
  const f = fixture();
  for (const version of [3, 5]) {
    f.db.pragma(`user_version = ${version}`);
    expect(f.check()).toBe(false);
    expect(f.db.pragma('user_version', { simple: true })).toBe(version);
  }
  f.db.pragma('user_version = 4');
  chmodSync(f.file, 0o644);
  expect(f.check()).toBe(false);
  chmodSync(f.file, 0o600);
  chmodSync(f.file + '-wal', 0o644);
  expect(f.check()).toBe(false);
  chmodSync(f.file + '-wal', 0o600);
  const replacement = join(f.directory, 'other.json');
  atomicPrivateJson(replacement, f.config);
  unlinkSync(f.configFile);
  symlinkSync(replacement, f.configFile);
  expect(f.check()).toBe(false);
});

const success: HostMaintenanceReply = { kind: 'result', result: { ok: true, operation: null } };
const inspect = () => ({
  action: 'inspect' as const,
  reference: { id: randomUUID(), revision: 1 },
});
async function control(execute: HostMaintenanceControl['execute']) {
  const f = fixture();
  let clock = 0;
  const registry = new LeaseRegistry(() => clock);
  cleanups.push(() => registry.dispose());
  const oldUpdate = vi.fn(async () => ({ ok: true as const, operation: null }));
  cleanups.push(
    await startHostControl(
      f.home,
      registry,
      () => ({ port: 7434, version: { version: '0.4.0', protocol: PROTOCOL_VERSION } }),
      oldUpdate,
      { check: (p, c) => f.check(p, c), execute },
    ),
  );
  const client = new HostControlClient(
    async () => connect(ipcPath(f.home, 'host')),
    false,
    undefined,
    profile,
    f.claim,
  );
  cleanups.push(() => client.close());
  await client.establish();
  return {
    ...f,
    client,
    registry,
    oldUpdate,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

it.each(['grant', 'expiry', 'channel'] as const)(
  'revokes pending dispatch after %s loss and never revives its authority',
  async (loss) => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let authorised!: () => boolean;
    const execute = vi.fn(async (_command, check: () => boolean) => {
      authorised = check;
      await waiting;
      return success;
    });
    const f = await control(execute);
    const result = f.client.hostMaintenance(inspect());
    const outcome =
      loss === 'channel'
        ? expect(result).rejects.toThrow('inspect the operation')
        : expect(result).resolves.toMatchObject({
            kind: 'result',
            result: { ok: false, code: 'rejected' },
          });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(authorised()).toBe(true);
    if (loss === 'grant') f.db.prepare('DELETE FROM maintenance_grants').run();
    if (loss === 'expiry') f.advance(45_000);
    if (loss === 'channel') f.client.close();
    await vi.waitFor(() => expect(authorised()).toBe(false));
    if (loss === 'grant') {
      // Even reinstating the exact old tuple cannot revive this already rejected channel.
      f.db
        .prepare('INSERT INTO maintenance_grants VALUES (?, ?, ?)')
        .run(f.claim.device, f.claim.host, f.claim.grant);
      expect(authorised()).toBe(false);
    }
    release();
    await outcome;
  },
);

it('keeps ordinary profile access scoped and rejects host-wide RPCs and ungranted maintenance', async () => {
  const execute = vi.fn(async () => success);
  const f = await control(execute);
  expect(f.registry.controlAuthority(f.client.generation!)?.profile).toBe(profile);
  await expect(f.client.hostUpdate({ action: 'status' })).rejects.toThrow('unavailable');
  expect(f.oldUpdate).not.toHaveBeenCalled();
  const ordinary = new HostControlClient(
    async () => connect(ipcPath(f.home, 'host')),
    false,
    undefined,
    profile,
  );
  cleanups.push(() => ordinary.close());
  await ordinary.establish();
  await expect(ordinary.hostMaintenance(inspect())).rejects.toThrow('unavailable');
  const stale = new HostControlClient(
    async () => connect(ipcPath(f.home, 'host')),
    false,
    undefined,
    profile,
    { ...f.claim, grant: randomUUID() },
  );
  cleanups.push(() => stale.close());
  await expect(stale.establish()).rejects.toThrow('unavailable');
  expect(execute).not.toHaveBeenCalled();
});

it('bounds pending calls, rejects private reply fields, and cannot renew a revoked grant', async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execute = vi.fn(async () => {
    await waiting;
    return { ...success, receipt: '/private/stage' };
  });
  const f = await control(execute);
  const pending = Array.from({ length: 4 }, () => f.client.hostMaintenance(inspect()));
  await expect(f.client.hostMaintenance(inspect())).rejects.toThrow('limit reached');
  release();
  for (const reply of await Promise.all(pending))
    expect(reply).toEqual({
      kind: 'result',
      result: { ok: false, code: 'failed', operation: null },
    });
  f.db.prepare('DELETE FROM maintenance_grants').run();
  expect(f.client.participate([])).toBe(true);
  await vi.waitFor(() => expect(f.client.state).toBe('upstream_unavailable'));
});

function rawRequest(socket: Socket, message: unknown): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const stop = jsonLines(
      socket,
      (value) => {
        stop();
        resolve(controlResponseSchema.parse(value));
      },
      () => reject(new Error('Invalid reply')),
    );
    socket.write(JSON.stringify(message) + '\n');
  });
}
function rawSocket(home: string) {
  const socket = connect(ipcPath(home, 'host'));
  socket.on('error', () => {});
  cleanups.push(() => {
    socket.destroy();
  });
  return socket;
}

it('enforces grant scope on raw requests rather than relying on client-side capability checks', async () => {
  const execute = vi.fn(async () => success);
  const f = await control(execute);
  const noProfile = rawSocket(f.home);
  expect(await rawRequest(noProfile, { t: 'open', maintenance: f.claim })).toEqual({
    t: 'error',
    code: 'rejected',
  });
  for (const open of [{ t: 'open' }, { t: 'open', profile }]) {
    const socket = rawSocket(f.home);
    expect(await rawRequest(socket, open)).toMatchObject({ t: 'authority' });
    expect(
      await rawRequest(socket, {
        t: 'host-maintenance',
        request_id: randomUUID(),
        command: inspect(),
      }),
    ).toMatchObject({ result: { kind: 'result', result: { ok: false, code: 'rejected' } } });
    expect(
      await rawRequest(socket, {
        t: 'host-maintenance',
        request_id: randomUUID(),
        command: { action: 'status' },
      }),
    ).toMatchObject({ result: { kind: 'status', status: { availability: 'unavailable' } } });
  }
  const socket = rawSocket(f.home);
  await rawRequest(socket, { t: 'open', profile, maintenance: f.claim });
  expect(
    await rawRequest(socket, {
      t: 'host-update',
      request_id: randomUUID(),
      command: { action: 'status' },
    }),
  ).toMatchObject({ result: { ok: false, code: 'rejected' } });
  expect(f.oldUpdate).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

it('bounds server concurrency and permanently consumes duplicate request identities', async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execute = vi.fn(async () => {
    await waiting;
    return success;
  });
  const f = await control(execute);
  const socket = rawSocket(f.home);
  await rawRequest(socket, { t: 'open', profile, maintenance: f.claim });
  const ids = Array.from({ length: 4 }, () => randomUUID());
  for (const request_id of ids)
    socket.write(JSON.stringify({ t: 'host-maintenance', request_id, command: inspect() }) + '\n');
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(4));
  expect(
    await rawRequest(socket, {
      t: 'host-maintenance',
      request_id: randomUUID(),
      command: inspect(),
    }),
  ).toMatchObject({ result: { kind: 'result', result: { code: 'unavailable' } } });
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.write(
    JSON.stringify({ t: 'host-maintenance', request_id: ids[0], command: inspect() }) + '\n',
  );
  socket.resume();
  await closed;
  release();
  expect(execute).toHaveBeenCalledTimes(4);
});
