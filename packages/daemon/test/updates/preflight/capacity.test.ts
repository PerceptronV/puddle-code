import { join } from 'node:path';
import type { StorageStatus } from '@puddle/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { StorageMonitor } from '../../../src/storage/monitor.js';
import { HostUpdateCapacity } from '../../../src/updates/preflight/capacity.js';
import { candidateFixture } from './helpers.js';

afterEach(() => vi.useRealTimers());

function setup(component: 'daemon' | 'runtime' = 'daemon') {
  const f = candidateFixture(component);
  const probe = vi.fn(async (path: string): Promise<StorageStatus['volumes'][number]> => ({
    path,
    available_bytes: 2 * 1024 ** 3,
    available_inodes: null,
    level: 'ok',
  }));
  const storage = new StorageMonitor(() => [f.home], probe);
  const capacity = new HostUpdateCapacity(
    { home: f.home, dbFile: join(f.home, 'puddle.db') },
    storage,
  );
  return { ...f, probe, storage, capacity };
}

it('checks actual update destinations afresh and preserves unknown inode metrics', async () => {
  const f = setup();
  await f.storage.refresh();
  f.probe.mockClear();
  const result = await f.capacity.inspect(f.operation);
  expect(result.blockers).toEqual([]);
  expect(f.probe.mock.calls.map(([path]) => path)).toEqual([
    join(f.home, 'bin'),
    join(f.home, 'updates'),
    join(f.home, 'puddle.db'),
  ]);
  expect(result.volumes.every((volume) => volume.available_inodes === null)).toBe(true);
  expect(f.storage.status().volumes).toEqual(expect.arrayContaining(result.volumes));
});

it.each(['bytes', 'inodes'] as const)(
  'blocks depleted %s even when the previous poll was healthy',
  async (metric) => {
    const f = setup();
    await f.storage.refresh();
    f.probe.mockImplementation(async (path) => ({
      path,
      available_bytes: metric === 'bytes' ? 0 : 2 * 1024 ** 3,
      available_inodes: metric === 'inodes' ? 0 : null,
      level: 'critical',
    }));
    expect((await f.capacity.inspect(f.operation)).blockers).toEqual([
      { code: 'storage_full', target: join(f.home, 'bin') },
      { code: 'storage_full', target: join(f.home, 'updates') },
      { code: 'storage_full', target: join(f.home, 'puddle.db') },
    ]);
  },
);

it('bounds stalled probes and coalesces checks without trusting the previous healthy poll', async () => {
  vi.useFakeTimers();
  const f = setup('runtime');
  await f.storage.refresh();
  f.probe.mockClear();
  f.probe.mockImplementation(() => new Promise(() => {}));
  const first = f.capacity.inspect(f.operation);
  const second = f.capacity.inspect(f.operation);
  await vi.advanceTimersByTimeAsync(6000);
  expect((await first).blockers).toEqual([
    { code: 'storage_unavailable', target: join(f.home, 'bin') },
    { code: 'storage_unavailable', target: join(f.home, 'updates') },
  ]);
  expect(await second).toEqual(await first);
  expect(f.probe).toHaveBeenCalledTimes(2);
});

it('rechecks unsaved observations after probing and keeps them until actual recovery', async () => {
  const f = setup();
  f.probe.mockImplementation(async (path) => {
    f.storage.setPendingRuntimeCount(1);
    f.storage.setLogsDegraded(true, 'screens');
    return { path, available_bytes: 2 * 1024 ** 3, available_inodes: null, level: 'ok' };
  });
  expect((await f.capacity.inspect(f.operation)).blockers).toEqual([
    { code: 'state_not_saved', target: 'database' },
    { code: 'state_not_saved', target: 'terminal_history' },
  ]);
  expect(f.storage.status()).toMatchObject({ database_degraded: true, logs_degraded: true });
});

it('changing the runtime default leaves degraded terminal history with its existing writers', async () => {
  const f = setup('runtime');
  f.storage.setLogsDegraded(true);
  expect((await f.capacity.inspect(f.operation)).blockers).toEqual([]);
  expect(f.probe.mock.calls.map(([path]) => path)).toEqual([
    join(f.home, 'bin'),
    join(f.home, 'updates'),
  ]);
  expect(f.storage.status().logs_degraded).toBe(true);
});
