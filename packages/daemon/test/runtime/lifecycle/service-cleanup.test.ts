import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { RUNTIME_PROTOCOL_VERSION } from '@puddle/shared';
import { RuntimeServiceCleanupStore } from '../../../src/db/stores/runtime-service-cleanup.js';
import { RuntimeServiceCleanup } from '../../../src/runtime/lifecycle/service-cleanup.js';
import { acquireHostClaim } from '../../../src/security/claims.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import { openDatabase } from '../../../src/db/db.js';
import {
  startRuntimeService,
  removeRuntimeService,
} from '../../../src/runtime/lifecycle/supervisor.js';
import type { CompilationCommandRunner } from '../../../src/compilation/process.js';
import { readRuntimeJson } from '../../../src/runtime/ownership/storage.js';
import { join } from 'node:path';

it('keeps paused cleanup pending until its supervisor result can be reinspected', async () => {
  const f = runtimeDatabase();
  f.runtimes.finish(f.binding.runtime_id, 'exited', () => {});
  const store = new RuntimeServiceCleanupStore(f.db);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const remove = vi.fn(async () => {
    await pending;
    return 'removed' as const;
  });
  const cleanup = new RuntimeServiceCleanup({
    home: f.home,
    store,
    reconciler: f.reconciler,
    remove,
  });
  try {
    const flush = cleanup.flush();
    const hold = cleanup.pause();
    const drained = vi.fn();
    const drain = hold.drain().then(drained);
    await cleanup.flush();
    expect(drained).not.toHaveBeenCalled();
    release();
    await Promise.all([flush, drain]);
    expect(remove).toHaveBeenCalledOnce();
    expect(store.pending()).toHaveLength(1);
    hold.release();
    await cleanup.flush();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(store.pending()).toEqual([]);
    const final = cleanup.pause();
    await cleanup.close();
    final.release();
    expect(() => cleanup.pause()).toThrow(/maintenance/);
  } finally {
    release();
    await cleanup.close();
    await f.reconciler.close();
    f.db.close();
  }
});

it('collects only ended bindings, preserves live claims and retries failed completion commits', async () => {
  const f = runtimeDatabase();
  const store = new RuntimeServiceCleanupStore(f.db);
  const cleanup = new RuntimeServiceCleanup({ home: f.home, store, reconciler: f.reconciler });
  try {
    store.complete(f.binding.runtime_id);
    expect(f.db.prepare('SELECT * FROM runtime_service_cleanup').all()).toEqual([]);
    await cleanup.flush();
    expect(store.pending()).toEqual([]);
    expect(() =>
      f.db.transaction(() => {
        f.runtimes.finish(f.binding.runtime_id, 'exited', () => {});
        throw new Error('rollback');
      })(),
    ).toThrow('rollback');
    expect(store.pending()).toEqual([]);
    f.runtimes.finish(f.binding.runtime_id, 'exited', () => {});
    const claim = acquireHostClaim(f.home, `runtime:${f.binding.runtime_id}`);
    try {
      await cleanup.flush();
      expect(store.pending()).toHaveLength(1);
    } finally {
      claim.release();
    }
    f.db.exec(
      "CREATE TRIGGER fail_cleanup BEFORE UPDATE ON runtime_service_cleanup BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    await cleanup.flush();
    expect(store.pending()).toHaveLength(1);
    f.db.exec('DROP TRIGGER fail_cleanup');
    await cleanup.flush();
    expect(store.pending()).toEqual([]);
    expect(f.runtimes.get(f.binding.runtime_id)?.state).toBe('exited');
    expect(f.sessions.get(f.session.id).id).toBe(f.session.id);
  } finally {
    await cleanup.close();
    await f.reconciler.close();
    f.db.close();
  }
});

it('keeps unconfirmed supervisor removal pending across controller replacement', async () => {
  const f = runtimeDatabase();
  f.runtimes.finish(f.binding.runtime_id, 'exited', () => {});
  const store = new RuntimeServiceCleanupStore(f.db);
  let absent = false;
  let bootouts = 0;
  const run: CompilationCommandRunner = async (command) => {
    if (command.args[0] === 'bootout') bootouts++;
    return { exitCode: command.args[0] === 'print' && absent ? 113 : 0, stdout: '', stderr: '' };
  };
  const record = await startRuntimeService(f.home, f.launch.identity, {
    kind: 'launchd',
    nodePath: process.execPath,
    entryPath: process.execPath,
    run,
  });
  const createCleanup = () =>
    new RuntimeServiceCleanup({
      home: f.home,
      store,
      reconciler: f.reconciler,
      remove: (home, identity) => removeRuntimeService(home, identity, run),
    });
  const cleanup = createCleanup();
  try {
    await cleanup.flush();
    expect(bootouts).toBe(1);
    expect(store.pending()).toHaveLength(1);
    expect(readRuntimeJson(join(f.directory, 'supervisor.json'))).toEqual(record);
    await cleanup.close();
    const replacement = createCleanup();
    try {
      // The already accepted unload finishes later. A new controller observes it.
      absent = true;
      await replacement.flush();
      expect(store.pending()).toEqual([]);
      expect(bootouts).toBe(1);
      expect(readRuntimeJson(join(f.directory, 'supervisor.json'))).toEqual({
        ...record,
        state: 'removed',
      });
    } finally {
      await replacement.close();
    }
  } finally {
    await cleanup.close();
    await f.reconciler.close();
    f.db.close();
  }
});

it('queues previously ended owners when upgrading without claiming cleanup already happened', async () => {
  const f = runtimeDatabase();
  f.runtimes.finish(f.binding.runtime_id, 'exited', () => {});
  f.db.exec(
    'DROP TABLE puddlang_outcome_dispositions; DROP TRIGGER runtime_service_cleanup_insert; DROP TRIGGER runtime_service_cleanup_end; DROP TABLE runtime_service_cleanup; PRAGMA user_version = 38',
  );
  await f.reconciler.close();
  f.db.close();
  const db = openDatabase(f.paths.dbFile);
  try {
    const store = new RuntimeServiceCleanupStore(db);
    expect(store.pending().map((row) => row.runtime_id)).toEqual([f.binding.runtime_id]);
    store.complete(f.binding.runtime_id);
    expect(store.pending()).toEqual([]);
  } finally {
    db.close();
  }
});

it('bounds cleanup concurrency and advances past an unavailable page without losing pending records', async () => {
  const f = runtimeDatabase();
  f.runtimes.finish(f.binding.runtime_id, 'exited', () => {});
  for (let i = 1; i < 35; i++) {
    const binding = f.runtimes.prepare({
      identity: {
        ...f.launch.identity,
        runtime_id: randomUUID(),
        incarnation: randomUUID(),
        launch_id: randomUUID(),
      },
      build: 'test',
      protocol: RUNTIME_PROTOCOL_VERSION,
      releasePath: f.directory,
    });
    f.runtimes.finish(binding.runtime_id, 'exited', () => {});
  }
  const store = new RuntimeServiceCleanupStore(f.db);
  const protectedIds = new Set(store.pending().map((row) => row.runtime_id));
  let active = 0;
  let maximum = 0;
  const remove = vi.fn(async (_home: string, identity: { runtime_id: string }) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return protectedIds.has(identity.runtime_id) ? ('owned' as const) : ('removed' as const);
  });
  const cleanup = new RuntimeServiceCleanup({
    home: f.home,
    store,
    reconciler: f.reconciler,
    remove,
  });
  try {
    await cleanup.flush();
    expect(remove).toHaveBeenCalledTimes(32);
    expect(maximum).toBe(4);
    await cleanup.flush();
    expect(remove).toHaveBeenCalledTimes(35);
    expect(
      f.db
        .prepare(
          'SELECT COUNT(*) AS count FROM runtime_service_cleanup WHERE completed_at IS NOT NULL',
        )
        .get(),
    ).toEqual({
      count: 3,
    });
    expect(store.pending()).toHaveLength(32);
    await cleanup.flush();
    expect(remove).toHaveBeenCalledTimes(67);
  } finally {
    await cleanup.close();
    await f.reconciler.close();
    f.db.close();
  }
});

it('drains in-flight work on shutdown and leaves its result inspectable for the next daemon', async () => {
  const f = runtimeDatabase();
  f.runtimes.finish(f.binding.runtime_id, 'exited', () => {});
  const store = new RuntimeServiceCleanupStore(f.db);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cleanup = new RuntimeServiceCleanup({
    home: f.home,
    store,
    reconciler: f.reconciler,
    remove: async () => {
      await pending;
      return 'removed';
    },
  });
  try {
    const flush = cleanup.flush();
    let closed = false;
    const closing = cleanup.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await Promise.all([flush, closing]);
    expect(store.pending()).toHaveLength(1);
    const replacement = new RuntimeServiceCleanup({
      home: f.home,
      store,
      reconciler: f.reconciler,
    });
    await replacement.flush();
    await replacement.close();
    expect(store.pending()).toEqual([]);
  } finally {
    release();
    await cleanup.close();
    await f.reconciler.close();
    f.db.close();
  }
});
