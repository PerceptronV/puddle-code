import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Account } from '@puddle/shared';
import { AccountObservations } from '../../../src/agents/accounts/observations.js';
import { AdapterRegistry } from '../../../src/agents/registry.js';
import type { AccountStore } from '../../../src/db/stores/accounts.js';
import { HostBackgroundTasks } from '../../../src/host/lifecycle/background.js';
import type { PtyManager } from '../../../src/pty/pty-manager.js';
import { fakeAdapter } from '../../helpers/daemon-fixtures.js';

function fixture(options: { binary?: string; noCheck?: boolean } = {}) {
  const account: Account = {
    id: 1,
    profile_id: 'fixture',
    agent_type: 'fake',
    label: 'fixture',
    config_dir: '/fixture',
    skip_permissions_default: false,
    logged_in: false,
    created_at: '2026-01-01T00:00:00Z',
  };
  const check = vi.fn(async () => true);
  const adapter = {
    ...fakeAdapter({ binary: options.binary ?? '/bin/sh' }),
    checkLoggedIn: options.noCheck ? undefined : check,
  };
  const save = vi.fn((_id: number, value: boolean) => {
    account.logged_in = value;
  });
  const accounts = { get: () => account, list: () => [account], setLoggedIn: save };
  const ptys = new EventEmitter();
  const background = new HostBackgroundTasks();
  const observer = new AccountObservations({
    accounts: accounts as unknown as AccountStore,
    adapters: new AdapterRegistry([adapter]),
    ptys: ptys as PtyManager,
    background,
  });
  return {
    account,
    check,
    save,
    background,
    observer,
    exit: (exitCode = 0) => ptys.emit('exit', { stream: 'login-1', term: 'agent', exitCode }),
    close: async () => {
      observer.close();
      await background.close();
    },
  };
}

describe('account authentication observations', () => {
  it('drains an admitted login probe and stops accepting exit observations on closure', async () => {
    const f = fixture();
    let release!: (loggedIn: boolean) => void;
    f.check.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    try {
      f.exit();
      await vi.waitFor(() => expect(f.check).toHaveBeenCalledOnce());
      f.observer.close();
      const closed = vi.fn();
      const closing = f.background.close().then(closed);
      f.exit();
      await Promise.resolve();
      expect(closed).not.toHaveBeenCalled();
      release(true);
      await closing;
      expect(f.account.logged_in).toBe(true);
      expect(f.save).toHaveBeenCalledOnce();
      expect(f.check).toHaveBeenCalledOnce();
    } finally {
      release?.(false);
      await f.close();
    }
  });

  it('serialises startup and login checks so an older result cannot overwrite the newer one', async () => {
    const f = fixture();
    let release!: (loggedIn: boolean) => void;
    f.check.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    try {
      f.observer.refresh();
      await vi.waitFor(() => expect(f.check).toHaveBeenCalledOnce());
      f.exit();
      await Promise.resolve();
      expect(f.check).toHaveBeenCalledOnce();
      release(false);
      await f.close();
      expect(f.check).toHaveBeenCalledTimes(2);
      expect(f.save.mock.calls.map(([, value]) => value)).toEqual([false, true]);
      expect(f.account.logged_in).toBe(true);
    } finally {
      release?.(false);
      await f.close();
    }
  });

  it('coalesces repeated exits during a probe into a fresh check after it finishes', async () => {
    const f = fixture();
    let release!: (loggedIn: boolean) => void;
    f.check.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    try {
      f.exit();
      await vi.waitFor(() => expect(f.check).toHaveBeenCalledOnce());
      for (let exit = 0; exit < 10; exit++) f.exit();
      release(false);
      await f.close();
      expect(f.check).toHaveBeenCalledTimes(2);
      expect(f.account.logged_in).toBe(true);
    } finally {
      release?.(false);
      await f.close();
    }
  });

  it('preserves the stored flag for absent binaries and unanswerable login checks', async () => {
    const f = fixture({ binary: '/missing/puddle-fixture-agent' });
    f.account.logged_in = true;
    f.check.mockRejectedValue(new Error('unavailable'));
    try {
      f.observer.refresh();
      const hold = f.background.pause();
      await hold.drain();
      hold.release();
      expect(f.check).not.toHaveBeenCalled();
      f.exit();
      await f.close();
      expect(f.check).toHaveBeenCalledOnce();
      expect(f.save).not.toHaveBeenCalled();
      expect(f.account.logged_in).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('uses successful login exit evidence only for adapters without an authentication check', async () => {
    const f = fixture({ noCheck: true });
    try {
      f.exit(1);
      f.observer.refresh();
      const hold = f.background.pause();
      await hold.drain();
      hold.release();
      expect(f.save).not.toHaveBeenCalled();
      f.exit();
      await f.close();
      expect(f.account.logged_in).toBe(true);
    } finally {
      await f.close();
    }
  });
});
