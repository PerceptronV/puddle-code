import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  acquireRuntimeController,
  readRuntimeController,
} from '../../../../src/runtime/ownership/storage.js';
import { acquireHostClaim } from '../../../../src/security/claims.js';
import { HostUpdateOperations } from '../../../../src/updates/operations/store.js';
import {
  ReleaseCollectionMaintenance,
  RELEASE_COLLECTION_MAINTENANCE,
} from '../../../../src/host/installation/collection/maintenance.js';
import { CollectionBudget } from '../../../../src/host/installation/collection/budget.js';
import { ReleaseReferenceInventory } from '../../../../src/host/installation/collection/inventory.js';
import { collectionRelease } from '../../../helpers/release-collection.js';
import { removalInstallationFixture } from '../../../helpers/removal-service.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.useRealTimers();
});
function fixture(
  pauseOverride?: () => Promise<{ release(): void }>,
  reclaimResults?: () => boolean,
  runtimeLogs?: ConstructorParameters<typeof ReleaseCollectionMaintenance>[0]['runtimeLogs'],
) {
  const f = removalInstallationFixture();
  f.guard.release();
  const controller = acquireRuntimeController(f.home);
  cleanups.push(() => {
    controller.release();
    f.close();
  });
  collectionRelease(f.home, '0.4.0~abc123');
  const old = collectionRelease(f.home, '0.3.9~abc123');
  const release = vi.fn();
  const pause = vi.fn(pauseOverride ?? (async () => ({ release })));
  const errors: unknown[] = [];
  const collector = new ReleaseCollectionMaintenance({
    home: f.home,
    runtimes: { releaseReferences: () => [], get: () => null },
    pause,
    reclaimResults,
    runtimeLogs,
    controller: () => ({ id: controller.record.id, epoch: controller.record.epoch }),
    boot: async () => randomUUID(),
    run: async () => {
      throw new Error('No supervisor command expected');
    },
    onError: (error) => errors.push(error),
  });
  cleanups.push(() => collector.close());
  return { ...f, collector, old, pause, release, errors, controller };
}

it('reclaims one bounded batch without advancing the live controller or touching selected software', async () => {
  const f = fixture();
  const before = readRuntimeController(f.home);
  await f.collector.flush();
  expect(f.errors).toEqual([]);
  expect(f.pause).toHaveBeenCalledOnce();
  expect(f.release).toHaveBeenCalledOnce();
  expect(existsSync(f.old.path)).toBe(false);
  expect(existsSync(join(f.home, 'bin/current'))).toBe(true);
  expect(readRuntimeController(f.home)).toEqual(before);
  expect(() => acquireHostClaim(f.home, 'daemon-controller')).toThrow();
  acquireHostClaim(f.home, 'host-update-coordinator').release();
  acquireHostClaim(f.home, 'host-update-execution').release();
});

it('commits result upkeep only under the existing pause/exclusion and coalesces further bounded work', async () => {
  const reclaim = vi.fn(() => {
    expect(f.pause).toHaveBeenCalled();
    expect(() => acquireHostClaim(f.home, 'host-update-coordinator')).toThrow();
    return true;
  });
  const f = fixture(undefined, reclaim);
  const claim = acquireHostClaim(f.home, 'host-update-coordinator');
  await f.collector.flush();
  expect(reclaim).not.toHaveBeenCalled();
  claim.release();
  vi.useFakeTimers();
  await f.collector.flush();
  expect(reclaim).toHaveBeenCalledOnce();
  const flush = vi.spyOn(f.collector, 'flush').mockResolvedValue();
  await vi.advanceTimersByTimeAsync(RELEASE_COLLECTION_MAINTENANCE.minimumMs - 1);
  expect(flush).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(flush).toHaveBeenCalledOnce();
});

it('holds maintenance exclusion for bounded runtime history and closes its cursor after draining', async () => {
  let finish!: (value: boolean) => void;
  const runtimeLogs = {
    sweep: vi.fn(async (requireCurrent: () => void, deadline: number) => {
      requireCurrent();
      expect(f.pause).toHaveBeenCalled();
      expect(() => acquireHostClaim(f.home, 'host-update-execution')).toThrow();
      expect(deadline - performance.now()).toBeLessThanOrEqual(1000);
      return new Promise<boolean>((resolve) => {
        finish = resolve;
      });
    }),
    close: vi.fn(async () => {}),
  };
  const f = fixture(undefined, undefined, runtimeLogs);
  const flushing = f.collector.flush();
  await vi.waitFor(() => expect(runtimeLogs.sweep).toHaveBeenCalledOnce());
  const closing = f.collector.close();
  expect(runtimeLogs.close).not.toHaveBeenCalled();
  finish(true);
  await Promise.all([flushing, closing]);
  expect(runtimeLogs.close).toHaveBeenCalledOnce();
  acquireHostClaim(f.home, 'host-update-execution').release();
});

it.each(['host-update-coordinator', 'host-update-execution'])(
  'skips busy %s before pausing',
  async (scope) => {
    const f = fixture();
    const claim = acquireHostClaim(f.home, scope);
    try {
      await f.collector.flush();
    } finally {
      claim.release();
    }
    expect(f.pause).not.toHaveBeenCalled();
    expect(existsSync(f.old.path)).toBe(true);
  },
);

it('skips unresolved preparation and never makes its completion depend on collection', async () => {
  const f = fixture();
  const operations = new HostUpdateOperations(f.home);
  const { operation } = operations.begin([{ component: 'runtime', version: '0.4.1' }]);
  await f.collector.flush();
  expect(f.pause).not.toHaveBeenCalled();
  expect(operations.read()).toEqual(operation);
  expect(existsSync(f.old.path)).toBe(true);
});

it('cancels a pending pause on shutdown and releases all exclusion once its drain settles', async () => {
  let resume!: (hold: { release(): void }) => void;
  const pending = new Promise<{ release(): void }>((resolve) => {
    resume = resolve;
  });
  const f = fixture(() => pending);
  const flushing = f.collector.flush();
  await vi.waitFor(() => expect(f.pause).toHaveBeenCalledOnce());
  const closing = f.collector.close();
  const release = vi.fn();
  resume({ release });
  await Promise.all([flushing, closing]);
  expect(release).toHaveBeenCalledOnce();
  expect(existsSync(f.old.path)).toBe(true);
  acquireHostClaim(f.home, 'host-update-coordinator').release();
  acquireHostClaim(f.home, 'host-update-execution').release();
  await f.collector.flush();
  expect(f.pause).toHaveBeenCalledOnce();
});

it('continues only its recorded quarantine on the next pass without expanding the batch', async () => {
  const f = fixture();
  for (let index = 0; index < 600; index++)
    writeFileSync(join(f.old.path, `file-${index}`), 'fixture');
  await f.collector.flush();
  const read = () =>
    JSON.parse(readFileSync(join(f.home, 'installation/collection/current.json'), 'utf8')) as {
      id: string;
      actions: Array<{ state: string }>;
    };
  const first = read();
  expect(first.actions.some(({ state }) => state !== 'finished')).toBe(true);
  const later = collectionRelease(f.home, '0.3.8~abc123');
  await f.collector.flush();
  expect(f.errors).toEqual([]);
  expect(read().id).toBe(first.id);
  expect(read().actions.every(({ state }) => state === 'finished')).toBe(true);
  expect(existsSync(later.path)).toBe(true);
});

it('coalesces repeated triggers without postponement or frequent host pauses', async () => {
  const f = fixture();
  vi.useFakeTimers();
  // Replace the real startup timer before advancing the fixture clock.
  const flush = vi.spyOn(f.collector, 'flush').mockResolvedValue();
  f.collector.request();
  await vi.advanceTimersByTimeAsync(500);
  f.collector.request();
  await vi.advanceTimersByTimeAsync(500);
  expect(flush).toHaveBeenCalledOnce();
  flush.mockRestore();
  await f.collector.flush();
  f.collector.request();
  const paused = f.pause.mock.calls.length;
  await vi.advanceTimersByTimeAsync(RELEASE_COLLECTION_MAINTENANCE.minimumMs - 1);
  expect(f.pause).toHaveBeenCalledTimes(paused);
});

it('limits aggregate metadata across directories instead of granting a new budget per record', async () => {
  const f = fixture();
  const budget = new CollectionBudget({ bytes: 100, entries: 32, references: 32 });
  const index = new ReleaseReferenceInventory(f.home, () => {}, budget);
  await expect(index.inspect()).rejects.toThrow('byte budget');
  expect(existsSync(f.old.path)).toBe(true);
});
