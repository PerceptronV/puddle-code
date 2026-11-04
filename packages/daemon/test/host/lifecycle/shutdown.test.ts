import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { startDaemon } from '../../../src/daemon.js';
import { readRuntime } from '../../../src/runtime-file.js';
import { openDatabase } from '../../../src/db/db.js';
import { AccountStore } from '../../../src/db/stores/accounts.js';
import { ProfileStore } from '../../../src/db/stores/profiles.js';
import { ensureHome, resolvePaths } from '../../../src/paths.js';
import { fakeAdapter } from '../../helpers/daemon-fixtures.js';

it('closes client admission immediately and retains SQLite until admitted work finishes', async () => {
  // No accounts, providers or terminals: only this temporary daemon owns a socket.
  const home = await mkdtemp(join(tmpdir(), 'puddle-shutdown-'));
  const daemon = await startDaemon({ home, adapters: [], port: 0 });
  let finish!: () => void;
  const request = daemon.admission.run(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const drain = vi.spyOn(daemon.admission, 'drain');
  let stopping: Promise<void> | undefined;
  try {
    stopping = daemon.stop();
    expect(daemon.stop()).toBe(stopping);
    expect(() => daemon.admission.enter()).toThrow(/maintenance/);
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
    expect(readRuntime(daemon.paths)).toMatchObject({ port: daemon.port });
    // A missing row still reaches the live store and returns the domain error.
    expect(() => daemon.service.get('absent')).toThrow(/does not exist/);
    finish();
    await request;
    await stopping;
    expect(readRuntime(daemon.paths)).toBeNull();
    expect(() => daemon.service.get('absent')).toThrow(/database connection is not open/);
    expect(daemon.stop()).toBe(stopping);
  } finally {
    finish();
    await request;
    await (stopping ?? daemon.stop());
    await rm(home, { recursive: true, force: true });
  }
});

it('waits for an admitted startup account check to save its result before closing SQLite', async () => {
  const home = await mkdtemp(join(tmpdir(), 'puddle-upkeep-shutdown-'));
  const paths = resolvePaths(home);
  ensureHome(paths);
  const seed = openDatabase(paths.dbFile);
  const profile = new ProfileStore(seed).create({ name: 'fixture', branch_prefix: '' });
  const account = new AccountStore(seed).create({
    profile_id: profile.id,
    agent_type: 'fake',
    label: 'fixture',
    config_dir: home,
    skip_permissions_default: false,
  });
  seed.close();
  let finish!: (loggedIn: boolean) => void;
  const probe = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  // The existing binary check succeeds, but the fake adapter never starts a CLI.
  const checkLoggedIn = vi.fn(() => probe);
  const daemon = await startDaemon({
    home,
    port: 0,
    adapters: [{ ...fakeAdapter({ binary: '/bin/sh' }), checkLoggedIn }],
  });
  let stopping: Promise<void> | undefined;
  try {
    await vi.waitFor(() => expect(checkLoggedIn).toHaveBeenCalledOnce());
    const drain = vi.spyOn(daemon.service, 'drainObservations');
    const stopped = vi.fn();
    stopping = daemon.stop().then(stopped);
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
    expect(stopped).not.toHaveBeenCalled();
    finish(true);
    await stopping;
    const verified = openDatabase(paths.dbFile);
    try {
      expect(new AccountStore(verified).get(account.id).logged_in).toBe(true);
    } finally {
      verified.close();
    }
  } finally {
    finish(false);
    await (stopping ?? daemon.stop());
    await rm(home, { recursive: true, force: true });
  }
});
