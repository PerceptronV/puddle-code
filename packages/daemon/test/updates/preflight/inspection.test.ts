import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { hostReleaseCapabilities, type StorageStatus } from '@puddle/shared';
import { HostUpdateCompatibility } from '../../../src/updates/preflight/compatibility.js';
import { HostUpdateCapacity } from '../../../src/updates/preflight/capacity.js';
import { HostUpdateImpact } from '../../../src/updates/preflight/impact.js';
import { HostUpdateConnector } from '../../../src/updates/preflight/connector.js';
import { HostUpdateInspection } from '../../../src/updates/preflight/inspection.js';
import { HostUpdateSupervision } from '../../../src/updates/preflight/supervision.js';
import { systemdObservation } from '../../helpers/host-supervision.js';
import { StorageMonitor } from '../../../src/storage/monitor.js';
import { candidateFixture } from './helpers.js';
import { DATABASE_SCHEMA_VERSION } from '../../../src/db/migrations/index.js';

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
  writeFileSync(join(f.home, 'supervisor'), 'systemd');
  const supervisor = vi.fn(async () => ({
    exitCode: 0,
    stdout: systemdObservation(123),
    stderr: '',
  }));
  const connector = new HostUpdateConnector(f.home, f.home);
  const databaseSchemaVersion = vi.fn(() => DATABASE_SCHEMA_VERSION);
  const inspection = new HostUpdateInspection({
    connector,
    compatibility: new HostUpdateCompatibility({
      home: f.home,
      current,
      databaseSchemaVersion,
      runtimes: { live: () => [], get: () => null },
      connections: { get: () => null },
    }),
    capacity: new HostUpdateCapacity({ home: f.home, dbFile: join(f.home, 'puddle.db') }, storage),
    supervision: new HostUpdateSupervision({
      home: f.home,
      pid: 123,
      platform: 'linux',
      run: supervisor,
    }),
    impact: new HostUpdateImpact({
      controller: randomUUID(),
      ptys: { interruptionInventory: () => [] },
      notebooks: { interruptionInventory: () => [] },
      compilation: { interruptionInventory: () => [] },
      puddlang: { interruptionInventory: () => [...programmes] },
    }),
  });
  const inspect = (operation = f.operation) =>
    inspection.inspect(operation, current.application, current.runtime);
  return {
    ...f,
    current,
    programmes,
    probe,
    storage,
    inspection,
    inspect,
    supervisor,
    connector,
    databaseSchemaVersion,
  };
}

it('rechecks database migration evidence after the final asynchronous connector probe', async () => {
  const f = setup();
  const inspect = f.connector.inspect.bind(f.connector);
  let probes = 0;
  vi.spyOn(f.connector, 'inspect').mockImplementation(async (operation) => {
    const result = await inspect(operation);
    if (++probes === 2) f.databaseSchemaVersion.mockReturnValue(DATABASE_SCHEMA_VERSION + 1);
    return result;
  });
  const result = await f.inspect();
  expect(result.fingerprint).toBeNull();
  expect(result.blockers).toContainEqual({ code: 'database_schema_changed', target: 'daemon' });
});

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
  );
  expect(result.blockers).toEqual(
    expect.arrayContaining([
      { code: 'frontend_incompatible', target: 'frontend' },
      { code: 'state_not_saved', target: 'database' },
    ]),
  );
  expect(result.fingerprint).toBeNull();
  expect(f.store.read()?.phase).toBe('staged');
});

it('binds approval to the observed service invocation and withholds it for unknown supervision', async () => {
  const f = setup();
  const first = await f.inspect();
  f.supervisor.mockImplementation(async () => ({
    exitCode: 0,
    stdout: systemdObservation(123).replace('a'.repeat(32), 'b'.repeat(32)),
    stderr: '',
  }));
  expect((await f.inspect()).fingerprint).not.toBe(first.fingerprint);
  f.supervisor.mockImplementation(async () => ({
    exitCode: 0,
    stdout: systemdObservation(456),
    stderr: '',
  }));
  const unknown = await f.inspect();
  expect(unknown.fingerprint).toBeNull();
  expect(unknown.blockers).toContainEqual({ code: 'daemon_supervision_unknown', target: 'daemon' });
});

it('withholds approval when a connector starts or changes during inspection', async () => {
  const f = setup();
  const probe = vi.spyOn(f.connector, 'inspect');
  probe.mockResolvedValueOnce({ state: 'absent', identity: null, blockers: [] });
  probe.mockResolvedValueOnce({
    state: 'unknown',
    identity: null,
    blockers: [{ code: 'connector_inventory_unknown', target: 'connector' }],
  });
  const observed = await f.inspect();
  expect(observed.fingerprint).toBeNull();
  expect(observed.blockers).toContainEqual({
    code: 'connector_inventory_changed',
    target: 'connector',
  });
  expect(observed.blockers).toContainEqual({
    code: 'connector_inventory_unknown',
    target: 'connector',
  });
});

it('rechecks the owner inventory after the final connector probe', async () => {
  const f = setup();
  const changed = vi.spyOn(HostUpdateCompatibility.prototype, 'inventoryMatches');
  const probe = vi.spyOn(f.connector, 'inspect');
  const absent = { state: 'absent' as const, identity: null, blockers: [] };
  probe.mockResolvedValueOnce(absent).mockImplementationOnce(async () => {
    changed.mockReturnValueOnce(false);
    return absent;
  });
  try {
    const observed = await f.inspect();
    expect(observed.fingerprint).toBeNull();
    expect(observed.blockers).toContainEqual({
      code: 'runtime_inventory_unknown',
      target: 'inventory',
    });
  } finally {
    changed.mockRestore();
  }
});
