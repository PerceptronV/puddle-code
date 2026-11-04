import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { RuntimeState } from '@puddle/shared';
import { migrateSessionAccount } from '../../../src/sessions/migration/service.js';
import { AdapterRegistry } from '../../../src/agents/registry.js';
import { AccountStore } from '../../../src/db/stores/accounts.js';
import { ProjectStore } from '../../../src/db/stores/projects.js';
import type { RuntimeControls } from '../../../src/runtime/controller/controls.js';
import type { MarkerFileSync } from '../../../src/sessions/onboarding.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import { runtimeTestAdapter } from '../../helpers/runtime-test-adapter.js';
import { runtimeRelease } from '../../helpers/runtime-release.js';
import { resolveInstalledRuntimeRelease } from '../../../src/runtime/lifecycle/release.js';

function fixture() {
  const f = runtimeDatabase('interactive');
  const accounts = new AccountStore(f.db);
  const directory = join(f.home, 'target');
  mkdirSync(directory);
  const target = accounts.create({
    profile_id: f.profile.id,
    agent_type: 'runtime-test',
    label: 'target',
    config_dir: directory,
    skip_permissions_default: false,
  });
  f.sessions.setAgentSessionRef(f.session.id, 'exact-ref');
  f.sessions.setStatus(f.session.id, 'running');
  f.db
    .prepare("UPDATE runtime_bindings SET state = 'running' WHERE runtime_id = ?")
    .run(f.binding.runtime_id);
  runtimeRelease(f.home, '0.4.0').select();
  const copied = vi.fn(async () => {});
  const adapter = { ...runtimeTestAdapter, migrateSession: copied };
  const state = {
    identity: f.launch.identity,
    history: { current: { id: f.binding.active_segment_id, agent_session_ref: 'exact-ref' } },
    agent: { agent_session_ref: 'exact-ref' },
  } as RuntimeState;
  let authorised = true;
  const stop = vi.fn(
    async (_id: string, authority: () => boolean, review?: (state: RuntimeState) => void) => {
      expect(authority()).toBe(true);
      review?.(state);
      f.runtimes.finish(f.binding.runtime_id, 'exited', () =>
        f.sessions.setStatus(f.session.id, 'exited'),
      );
    },
  );
  const resumed = vi.fn<Parameters<typeof migrateSessionAccount>[4]['resume']>(
    async (_session, _account, _adapter, _profile, _ref, guard) => {
      guard(resolveInstalledRuntimeRelease(f.home));
    },
  );
  const operations = {
    checkLoggedIn: vi.fn(async () => {}),
    kill: vi.fn(async () => {
      f.sessions.setStatus(f.session.id, 'exited');
      return f.sessions.get(f.session.id);
    }),
    resume: resumed,
  } satisfies Parameters<typeof migrateSessionAccount>[4];
  const deps = {
    ...f,
    accounts,
    projects: new ProjectStore(f.db),
    adapters: new AdapterRegistry([adapter]),
    runtimeControls: { stop } as unknown as RuntimeControls,
    onboarding: { watch: vi.fn() } as unknown as MarkerFileSync,
  };
  return {
    ...f,
    target,
    accounts,
    state,
    stop,
    copied,
    operations,
    deps,
    revoke: () => {
      authorised = false;
    },
    migrate: () =>
      migrateSessionAccount(deps, f.session.id, target.id, () => authorised, operations),
    async close() {
      await f.reconciler.close();
      f.db.close();
    },
  };
}

it('stops the exact owner before copying and resumes the unchanged native conversation under the target', async () => {
  const f = fixture();
  try {
    f.copied.mockImplementation(async () => {
      expect(f.runtimes.get(f.binding.runtime_id)?.state).toBe('exited');
      expect(f.sessions.get(f.session.id).account_id).toBe(f.account!.id);
    });
    await f.migrate();
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.copied).toHaveBeenCalledWith('exact-ref', f.account, f.target, f.home);
    expect(f.operations.resume).toHaveBeenCalledWith(
      expect.objectContaining({ id: f.session.id }),
      f.target,
      expect.anything(),
      f.profile.id,
      'exact-ref',
      expect.any(Function),
    );
    expect(f.sessions.get(f.session.id).account_id).toBe(f.target.id);
    expect(f.events.list(f.session.id).map(({ type }) => type)).toEqual(['killed', 'migrated']);
  } finally {
    await f.close();
  }
});

it.each([
  'authority',
  'native-ref',
  'segment',
  'source-account',
  'target-account',
  'profile',
] as const)('does not stop or copy after %s changes during admission', async (change) => {
  const f = fixture();
  try {
    f.operations.checkLoggedIn.mockImplementation(async () => {
      if (change === 'authority') f.revoke();
      if (change === 'native-ref') f.state.agent!.agent_session_ref = 'another-ref';
      if (change === 'segment')
        f.db.prepare('UPDATE runtime_bindings SET active_segment_id = ?').run(randomUUID());
      if (change === 'source-account') f.sessions.setAccountId(f.session.id, f.target.id);
      if (change === 'target-account')
        f.db
          .prepare('UPDATE accounts SET config_dir = ? WHERE id = ?')
          .run(join(f.home, 'other'), f.target.id);
      if (change === 'profile') {
        const other = f.profiles.create({ name: 'other', branch_prefix: '' });
        f.db.prepare('UPDATE projects SET profile_id = ? WHERE id = ?').run(other.id, f.project.id);
      }
    });
    await expect(f.migrate()).rejects.toBeDefined();
    expect(f.runtimes.get(f.binding.runtime_id)?.state).toBe('running');
    expect(f.copied).not.toHaveBeenCalled();
    expect(f.operations.resume).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it('retains account and native data after uncertain stop without resubmission', async () => {
  const f = fixture();
  try {
    f.stop.mockRejectedValue(new Error('Clean exit unconfirmed'));
    await expect(f.migrate()).rejects.toThrow('Clean exit unconfirmed');
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.copied).not.toHaveBeenCalled();
    expect(f.operations.resume).not.toHaveBeenCalled();
    expect(f.sessions.get(f.session.id).account_id).toBe(f.account!.id);
  } finally {
    await f.close();
  }
});

it.each([false, true])(
  'rolls back copied data only before replacement intent (admitted=%s)',
  async (admitted) => {
    const f = fixture();
    try {
      f.operations.resume.mockImplementation(async (_s, _a, _adapter, _p, _ref, guard) => {
        guard(resolveInstalledRuntimeRelease(f.home));
        if (admitted) {
          const replacement = f.runtimes.prepare({
            identity: {
              ...f.launch.identity,
              runtime_id: randomUUID(),
              incarnation: randomUUID(),
              launch_id: randomUUID(),
            },
            build: 'fixture',
            protocol: { major: 1, minor: 0 },
            releasePath: f.home,
          });
          f.runtimes.finish(replacement.runtime_id, 'failed', () =>
            f.sessions.setStatus(f.session.id, 'exited'),
          );
        }
        throw new Error('Launch failed');
      });
      await expect(f.migrate()).rejects.toThrow('Launch failed');
      expect(f.copied).toHaveBeenCalledTimes(admitted ? 1 : 2);
      expect(f.sessions.get(f.session.id).account_id).toBe(admitted ? f.target.id : f.account!.id);
      if (!admitted)
        expect(f.copied).toHaveBeenLastCalledWith('exact-ref', f.target, f.account, f.home);
    } finally {
      await f.close();
    }
  },
);

it('rechecks revocation at replacement admission and preserves the original account on copy rollback', async () => {
  const f = fixture();
  try {
    f.operations.resume.mockImplementation(async (_s, _a, _adapter, _p, _ref, guard) => {
      f.revoke();
      guard(resolveInstalledRuntimeRelease(f.home));
    });
    await expect(f.migrate()).rejects.toMatchObject({ code: 'upstream_expired' });
    expect(f.copied).toHaveBeenCalledTimes(2);
    expect(f.sessions.get(f.session.id).account_id).toBe(f.account!.id);
  } finally {
    await f.close();
  }
});

it('keeps the existing explicit migration path for exited and legacy placements', async () => {
  const f = fixture();
  try {
    f.runtimes.finish(f.binding.runtime_id, 'exited', () =>
      f.sessions.setStatus(f.session.id, 'exited'),
    );
    await f.migrate();
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.operations.kill).not.toHaveBeenCalled();
    expect(f.sessions.get(f.session.id).account_id).toBe(f.target.id);
  } finally {
    await f.close();
  }
});

it.each(['unsupported', 'foreign-profile', 'wrong-agent'] as const)(
  'refuses %s before stopping a live owner',
  async (failure) => {
    const f = fixture();
    try {
      if (failure === 'unsupported') f.deps.adapters.get('runtime-test').migrateSession = undefined;
      if (failure === 'foreign-profile') {
        const other = f.profiles.create({ name: 'other', branch_prefix: '' });
        f.db.prepare('UPDATE accounts SET profile_id = ? WHERE id = ?').run(other.id, f.target.id);
      }
      if (failure === 'wrong-agent')
        f.db.prepare('UPDATE accounts SET agent_type = ? WHERE id = ?').run('other', f.target.id);
      await expect(f.migrate()).rejects.toMatchObject({
        code:
          failure === 'unsupported'
            ? 'migration_unsupported'
            : failure === 'foreign-profile'
              ? 'cross_profile_account'
              : 'agent_mismatch',
      });
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.copied).not.toHaveBeenCalled();
      expect(f.operations.resume).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it('does not reverse a copy into a changed source account after asynchronous work', async () => {
  const f = fixture();
  try {
    f.copied.mockImplementation(async () => {
      f.db
        .prepare('UPDATE accounts SET config_dir = ? WHERE id = ?')
        .run(join(f.home, 'changed'), f.account!.id);
    });
    await expect(f.migrate()).rejects.toMatchObject({ code: 'session_changed' });
    expect(f.copied).toHaveBeenCalledTimes(1);
    expect(f.operations.resume).not.toHaveBeenCalled();
    expect(f.sessions.get(f.session.id).account_id).toBe(f.account!.id);
  } finally {
    await f.close();
  }
});

it('rejects replacement admission after the profile permission gate closes', async () => {
  const f = fixture();
  try {
    f.deps.adapters.get('runtime-test').capabilities.skipPermissions = true;
    f.sessions.setSkipPermissions(f.session.id, true);
    f.accounts.setSkipPermissionsDefault(f.target.id, true);
    f.profiles.patchSettings(f.profile.id, { allowSkipPermissions: true });
    f.operations.resume.mockImplementation(async (_s, _a, _adapter, _p, _ref, guard) => {
      f.profiles.patchSettings(f.profile.id, { allowSkipPermissions: false });
      guard(resolveInstalledRuntimeRelease(f.home));
    });
    await expect(f.migrate()).rejects.toMatchObject({ code: 'session_changed' });
    expect(f.copied).toHaveBeenCalledTimes(2);
    expect(f.sessions.get(f.session.id).account_id).toBe(f.account!.id);
  } finally {
    await f.close();
  }
});

it('keeps shared-store migration on the target for explicit resume after launch failure', async () => {
  const f = fixture();
  try {
    Object.assign(f.deps.adapters.get('runtime-test'), {
      conversationShare: {
        storeParent: () => f.home,
        locateStoreDir: () => f.home,
        sessionFiles: () => ({ inStore: [], perAccount: [] }),
      },
      hasConversation: () => true,
    });
    f.operations.resume.mockRejectedValue(new Error('Resume failed'));
    await expect(f.migrate()).rejects.toThrow('Resume failed');
    expect(f.copied).not.toHaveBeenCalled();
    expect(f.sessions.get(f.session.id).account_id).toBe(f.target.id);
  } finally {
    await f.close();
  }
});

it('preserves the manual legacy stop and resume callbacks without an independent binding', async () => {
  const f = fixture();
  try {
    await migrateSessionAccount(
      { ...f.deps, runtimes: undefined, runtimeControls: undefined },
      f.session.id,
      f.target.id,
      () => true,
      f.operations,
    );
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.operations.kill).toHaveBeenCalledTimes(1);
    expect(f.operations.resume).toHaveBeenCalledTimes(1);
    expect(f.sessions.get(f.session.id).account_id).toBe(f.target.id);
  } finally {
    await f.close();
  }
});
