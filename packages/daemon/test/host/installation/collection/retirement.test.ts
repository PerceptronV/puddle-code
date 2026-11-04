import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import { runtimeBindingIdentity } from '../../../../src/runtime/transport/connections.js';
import { runtimeServiceName } from '../../../../src/runtime/lifecycle/supervisor.js';
import { acquireHostClaim } from '../../../../src/security/claims.js';
import { CollectionBudget } from '../../../../src/host/installation/collection/budget.js';
import {
  runtimeReleaseRetired,
  retireRuntimeRelease,
} from '../../../../src/host/installation/collection/retirement/runtimes.js';
import { inspectReleaseReferences } from '../../../../src/host/installation/collection/review.js';
import { runtimeDatabase } from '../../../helpers/runtime-database.js';
import { collectionRelease } from '../../../helpers/release-collection.js';
import { symlinkSync } from 'node:fs';

function fixture() {
  const f = runtimeDatabase();
  const old = collectionRelease(f.home, '0.3.9~abc123');
  const selected = collectionRelease(f.home, '0.4.0~abc123');
  symlinkSync(selected.path, join(f.home, 'bin/current'));
  f.db
    .prepare("UPDATE runtime_bindings SET release_path = ?, state = 'exited' WHERE runtime_id = ?")
    .run(old.path, f.binding.runtime_id);
  const binding = f.runtimes.get(f.binding.runtime_id)!;
  const identity = runtimeBindingIdentity(binding);
  atomicPrivateJson(join(f.directory, 'retired.json'), { format: 1, identity });
  atomicPrivateJson(join(f.directory, 'supervisor.json'), {
    format: 1,
    identity,
    kind: 'detached',
    name: runtimeServiceName(f.home, identity, 'detached'),
    domain: null,
    node_path: join(old.path, 'bin/node'),
    entry_path: join(old.path, 'daemon/puddler.mjs'),
    state: 'removed',
  });
  atomicPrivateJson(join(f.directory, 'assets.json'), {
    format: 1,
    node_path: join(old.path, 'bin/node'),
    files: {},
  });
  const run = vi.fn(async () => {
    throw new Error('Detached retirement must not issue a supervisor command');
  });
  const retire = (boot: string, write?: typeof atomicPrivateJson) =>
    retireRuntimeRelease(
      f.home,
      f.runtimes,
      binding.runtime_id,
      boot,
      () => {},
      run,
      new CollectionBudget(),
      write,
    );
  return {
    ...f,
    old,
    binding,
    retire,
    run,
    async close() {
      await f.reconciler.close();
      f.db.close();
    },
  };
}

it('retains same-boot provider orphans and retires only exact executable references after a verified reboot', async () => {
  const f = fixture();
  try {
    const replay = join(f.directory, 'retained-output');
    const native = join(f.home, 'native-conversation');
    writeFileSync(replay, 'terminal history');
    writeFileSync(native, 'conversation');
    const segments = f.db.prepare('SELECT * FROM runtime_segments').all();
    const firstBoot = randomUUID();
    await f.retire(firstBoot);
    await f.retire(firstBoot);
    expect(runtimeReleaseRetired(f.home, f.binding)).toBe(false);
    expect((await inspectReleaseReferences(f.home, f.runtimes, () => {})).candidates).not.toContain(
      f.old.path,
    );
    await f.retire(randomUUID());
    expect(runtimeReleaseRetired(f.home, f.binding)).toBe(true);
    expect((await inspectReleaseReferences(f.home, f.runtimes, () => {})).candidates).toContain(
      f.old.path,
    );
    expect(f.runtimes.get(f.binding.runtime_id)).toEqual(f.binding);
    expect(f.db.prepare('SELECT * FROM runtime_segments').all()).toEqual(segments);
    expect(readFileSync(replay, 'utf8')).toBe('terminal history');
    expect(readFileSync(native, 'utf8')).toBe('conversation');
    rmSync(f.old.path, { recursive: true });
    await expect(inspectReleaseReferences(f.home, f.runtimes, () => {})).resolves.toHaveProperty(
      'candidates',
    );
    expect(f.runtimes.get(f.binding.runtime_id)).toEqual(f.binding);
    expect(f.run).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it.each(['runtime-launch', 'runtime-dispatch', 'runtime'])(
  'never retires an owner protected by %s',
  async (scope) => {
    const f = fixture();
    const claim = acquireHostClaim(f.home, `${scope}:${f.binding.runtime_id}`);
    try {
      await expect(f.retire(randomUUID())).rejects.toThrow();
      expect(existsSync(join(f.directory, 'release-retirement.json'))).toBe(false);
    } finally {
      claim.release();
      await f.close();
    }
  },
);

it('preserves a durable fence after a lost write and refuses changed helper or binding evidence', async () => {
  const f = fixture();
  try {
    const boot = randomUUID();
    await expect(
      f.retire(boot, (path, value, options) => {
        atomicPrivateJson(path, value, options);
        throw new Error('lost receipt reply');
      }),
    ).rejects.toThrow('lost receipt');
    await f.retire(boot);
    expect(runtimeReleaseRetired(f.home, f.binding)).toBe(false);
    atomicPrivateJson(join(f.directory, 'assets.json'), {
      format: 1,
      node_path: join(f.old.path, 'bin/node'),
      files: { 'changed.mjs': 'c'.repeat(64) },
    });
    await expect(f.retire(randomUUID())).rejects.toThrow();
    expect(runtimeReleaseRetired(f.home, f.binding)).toBe(false);
  } finally {
    await f.close();
  }
});

it('keeps a running or unfenced binding pinned regardless of a later boot', async () => {
  const f = fixture();
  try {
    f.db
      .prepare("UPDATE runtime_bindings SET state = 'running' WHERE runtime_id = ?")
      .run(f.binding.runtime_id);
    await f.retire(randomUUID());
    expect(existsSync(join(f.directory, 'release-retirement.json'))).toBe(false);
    expect((await inspectReleaseReferences(f.home, f.runtimes, () => {})).candidates).not.toContain(
      f.old.path,
    );
  } finally {
    await f.close();
  }
});

it('retires a valid launch larger than the small control-record allowance', async () => {
  const f = fixture();
  try {
    f.launch.capture_env = {
      enabled: true,
      values: { FIRST: 'x'.repeat(32 * 1024), SECOND: 'y'.repeat(32 * 1024) },
    };
    atomicPrivateJson(join(f.directory, 'launch.json'), f.launch);
    await f.retire(randomUUID());
    await f.retire(randomUUID());
    expect(runtimeReleaseRetired(f.home, f.binding)).toBe(true);
  } finally {
    await f.close();
  }
});

it.each([1, 10, 50])(
  'bounds reference inspection for %i retained runtimes without dropping live pins',
  async (count) => {
    const f = fixture();
    try {
      const rows = [
        f.binding,
        ...Array.from({ length: count - 1 }, () => ({ ...f.binding, runtime_id: randomUUID() })),
      ]
        .map((binding) => ({ ...binding, state: 'running' as const }))
        .sort((a, b) => a.runtime_id.localeCompare(b.runtime_id));
      for (const row of rows)
        mkdirSync(join(f.home, 'runtimes', row.runtime_id), { recursive: true, mode: 0o700 });
      const runtimes = {
        releaseReferences: (after = '') =>
          rows
            .filter(({ runtime_id }) => runtime_id > after)
            .map(({ runtime_id, release_path }) => ({ runtime_id, release_path })),
        get: (id: string) => rows.find(({ runtime_id }) => runtime_id === id) ?? null,
      };
      const budget = new CollectionBudget();
      const entries = vi.spyOn(budget, 'entry');
      const review = await inspectReleaseReferences(f.home, runtimes, () => {}, Date.now(), budget);
      expect(review.candidates).not.toContain(f.old.path);
      expect(
        review.releases
          .find(({ path }) => path === f.old.path)!
          .references.filter((reference) => reference.startsWith('runtime:')),
      ).toHaveLength(count);
      expect(entries.mock.calls.length).toBeLessThanOrEqual(2 * count + 8);
    } finally {
      await f.close();
    }
  },
);
