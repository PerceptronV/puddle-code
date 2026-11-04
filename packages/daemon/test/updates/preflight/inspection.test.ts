import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { hostReleaseCapabilities, type StorageStatus } from '@puddle/shared';
import { HostUpdateCompatibility } from '../../../src/updates/preflight/compatibility.js';
import { HostUpdateCapacity } from '../../../src/updates/preflight/capacity.js';
import { HostUpdateImpact } from '../../../src/updates/preflight/impact.js';
import { HostUpdateInspection } from '../../../src/updates/preflight/inspection.js';
import { StorageMonitor } from '../../../src/storage/monitor.js';
import { candidateFixture } from './helpers.js';

function setup() {
  const f = candidateFixture();
  const current = hostReleaseCapabilities('0.3.14');
  const programmes: Array<{ id: string }> = [];
  const probe = vi.fn(async (path: string): Promise<StorageStatus['volumes'][number]> => ({
    path,
    available_bytes: 2 * 1024 ** 3,
    available_inodes: null,
    level: 'ok',
  }));
  const storage = new StorageMonitor(() => [], probe);
  const inspection = new HostUpdateInspection({
    compatibility: new HostUpdateCompatibility({
      home: f.home,
      current,
      runtimes: { live: () => [], get: () => null },
      connections: { get: () => null },
    }),
    capacity: new HostUpdateCapacity({ home: f.home, dbFile: join(f.home, 'puddle.db') }, storage),
    impact: new HostUpdateImpact({
      controller: randomUUID(),
      ptys: { interruptionInventory: () => [] },
      notebooks: { interruptionInventory: () => [] },
      compilation: { interruptionInventory: () => [] },
      puddlang: { interruptionInventory: () => [...programmes] },
    }),
  });
  const inspect = (operation = f.operation) =>
    inspection.inspect(operation, current.application, current.runtime, null);
  return { ...f, current, programmes, probe, storage, inspection, inspect };
}

it('binds stable inspection to its operation and stages without treating changing free bytes as new impact', async () => {
  const f = setup();
  const first = await f.inspect();
  expect(first.blockers).toEqual([]);
  expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(f.store.read()?.phase).toBe('staged');
  let operation = f.store.preflight(f.operation, first.fingerprint!);
  operation = f.store.approve(operation, first.fingerprint!);
  f.probe.mockImplementation(async (path) => ({
    path,
    available_bytes: 800 * 1024 ** 2,
    available_inodes: null,
    level: 'warning',
  }));
  expect((await f.inspect(operation)).fingerprint).toBe(first.fingerprint);
  expect((await f.inspect({ ...operation, id: randomUUID() })).fingerprint).not.toBe(
    first.fingerprint,
  );
  const changedStage = {
    ...operation,
    stages: [{ ...operation.stages[0]!, digest: 'a'.repeat(64) }],
  };
  expect((await f.inspect(changedStage)).fingerprint).toBeNull();
});

it('refuses an approval fingerprint when new daemon-owned work appears during filesystem inspection', async () => {
  const f = setup();
  f.probe.mockImplementationOnce(async (path) => {
    f.programmes.push({ id: randomUUID() });
    return { path, available_bytes: 2 * 1024 ** 3, available_inodes: null, level: 'ok' };
  });
  const changing = await f.inspect();
  expect(changing.impact.requiresInterruption).toBe(true);
  expect(changing.blockers).toContainEqual({
    code: 'interruption_inventory_changed',
    target: 'daemon',
  });
  expect(changing.fingerprint).toBeNull();
  const settled = await f.inspect();
  expect(settled.fingerprint).not.toBeNull();
  let operation = f.store.preflight(f.operation, settled.fingerprint!);
  operation = f.store.approve(operation, settled.fingerprint!);
  f.programmes.push({ id: randomUUID() });
  const changed = await f.inspect(operation);
  expect(changed.fingerprint).not.toBe(settled.fingerprint);
  operation = f.store.preflight(operation, changed.fingerprint!);
  expect(operation.approved).toBeNull();
  expect(() => f.store.dispatch(operation)).toThrow();
});

it('collects protocol and capacity blockers without producing approval evidence', async () => {
  const f = setup();
  f.storage.setPendingRuntimeCount(1);
  const result = await f.inspection.inspect(
    f.operation,
    { major: f.current.application.major + 1, minor: 0 },
    f.current.runtime,
    null,
  );
  expect(result.blockers).toEqual(
    expect.arrayContaining([
      { code: 'cockpit_incompatible', target: 'cockpit' },
      { code: 'state_not_saved', target: 'database' },
    ]),
  );
  expect(result.fingerprint).toBeNull();
  expect(f.store.read()?.phase).toBe('staged');
});
