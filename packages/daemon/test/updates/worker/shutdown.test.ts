import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { HostUpdateWorker } from '@puddle/shared';
import { atomicPrivateJson, digest } from '@puddle/shared/node';
import { pendingDaemonUpdateShutdown } from '../../../src/updates/worker/shutdown.js';
import { updateWorkerDirectory } from '../../../src/updates/worker/supervisor.js';
import { acceptedCheckpointUpdate, checkpointWorker } from '../../helpers/update-checkpoint.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture(component: 'daemon' | 'runtime' = 'daemon') {
  const home = mkdtempSync(join(tmpdir(), 'puddle-update-shutdown-'));
  homes.push(home);
  const accepted = acceptedCheckpointUpdate(home, component);
  const controller = { id: randomUUID(), epoch: 4 };
  const outgoing = { pid: process.pid, controller };
  const job = checkpointWorker(home, accepted, outgoing);
  const file = join(updateWorkerDirectory(home, job.operation_id), 'worker.json');
  return { home, ...accepted, controller, outgoing, job, file };
}

it('addresses only the outgoing controller during accepted dispatch and execution', () => {
  const f = fixture();
  expect(pendingDaemonUpdateShutdown(f.home, f.controller)).toEqual(f.reference);
  expect(pendingDaemonUpdateShutdown(f.home, null)).toBeNull();
  expect(pendingDaemonUpdateShutdown(f.home, f.controller, process.pid + 1)).toBeNull();
  expect(pendingDaemonUpdateShutdown(f.home, { ...f.controller, id: randomUUID() })).toBeNull();
  expect(pendingDaemonUpdateShutdown(f.home, { ...f.controller, epoch: 5 })).toBeNull();
  const worker = f.store.claimExecution(f.operation, f.job.dispatch_id, f.job.preflight);
  try {
    expect(pendingDaemonUpdateShutdown(f.home, f.controller)).toEqual(f.reference);
    atomicPrivateJson(f.file, { ...f.job, dispatch_revision: f.job.dispatch_revision - 1 });
    expect(pendingDaemonUpdateShutdown(f.home, f.controller)).toBeNull();
    atomicPrivateJson(f.file, f.job);
    worker.verifying();
    expect(pendingDaemonUpdateShutdown(f.home, f.controller)).toBeNull();
  } finally {
    worker.release();
  }
});

it.each([
  ['another dispatch', { dispatch_id: randomUUID() }],
  ['another approval', { preflight: digest('changed') }],
  ['an earlier revision', { dispatch_revision: 1 }],
  ['a future revision', { dispatch_revision: 100 }],
  ['another operation', { operation_id: randomUUID() }],
  ['a legacy worker', { outgoing: undefined }],
] satisfies [string, Partial<HostUpdateWorker>][])(
  'does not checkpoint %s during ordinary shutdown',
  (_name, patch) => {
    const f = fixture();
    atomicPrivateJson(f.file, { ...f.job, ...patch });
    expect(pendingDaemonUpdateShutdown(f.home, f.controller)).toBeNull();
  },
);

it('ignores runtime-default jobs and dispatches fenced for recovery', () => {
  const runtime = fixture('runtime');
  expect(pendingDaemonUpdateShutdown(runtime.home, runtime.controller)).toBeNull();
  const f = fixture();
  f.store.requireRecovery(f.operation, 'Unconfirmed worker dispatch');
  expect(pendingDaemonUpdateShutdown(f.home, f.controller)).toBeNull();
});

it('leaves ordinary shutdown available when worker or ledger evidence is missing or damaged', () => {
  const f = fixture();
  writeFileSync(f.file, '{');
  expect(pendingDaemonUpdateShutdown(f.home, f.controller)).toBeNull();
  rmSync(f.file);
  expect(pendingDaemonUpdateShutdown(f.home, f.controller)).toBeNull();
  writeFileSync(join(f.home, 'updates', 'operations.json'), '{');
  expect(pendingDaemonUpdateShutdown(f.home, f.controller)).toBeNull();
  rmSync(join(f.home, 'updates', 'operations.json'));
  expect(pendingDaemonUpdateShutdown(f.home, f.controller)).toBeNull();
});
