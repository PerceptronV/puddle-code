import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { hostUpdateActionsSchema } from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { updateRecoveryDirectory } from '@puddle/shared/node/host-control';
import * as connectorInspection from '../../../../src/updates/preflight/connector.js';
import { readRuntimeController } from '../../../../src/runtime/ownership/storage.js';
import { startUpdateRecoveryWorker } from '../../../../src/updates/recovery/worker/supervisor.js';
import { executeUpdateRecovery } from '../../../../src/updates/recovery/worker/execute.js';
import { runningRecoveryFixture } from '../../../helpers/update-running-recovery.js';

async function fixture(start: 'started' | 'finished' = 'started') {
  const f = await runningRecoveryFixture('finished', true);
  f.actions.actions.at(-1)!.state = start;
  atomicPrivateJson(join(f.directory, 'actions.json'), f.actions);
  return f;
}

it.each(['inactive', 'failed', 'start-limited'] as const)(
  'accepts one fresh connector start after confirmed %s loss without restarting the daemon',
  async (state) => {
    const f = await fixture();
    f.running.failed = state !== 'inactive';
    f.running.limited = state === 'start-limited';
    const controller = readRuntimeController(f.home);
    const reference = f.store.read()!;
    const job = await startUpdateRecoveryWorker(f.home, reference, f.options);
    expect(job.connector_restart).toMatch(/^[a-f0-9]{64}$/);
    expect(f.running.changes).toEqual([]);
    expect(await startUpdateRecoveryWorker(f.home, reference, f.options)).toEqual(job);
    f.running.afterStart = () => {
      const journal = hostUpdateActionsSchema.parse(
        JSON.parse(
          readFileSync(
            join(updateRecoveryDirectory(f.home, reference.id), job.id, 'actions.json'),
            'utf8',
          ),
        ),
      );
      expect(journal.actions.at(-1)).toEqual({ action: 'start-connector', state: 'started' });
    };
    await executeUpdateRecovery(f.home, job, f.run);
    expect(f.running.changes).toEqual(
      state === 'start-limited' ? ['reset-connector', 'start-connector'] : ['start-connector'],
    );
    expect(f.store.read()?.phase).toBe('complete');
    expect(readRuntimeController(f.home)).toEqual(controller);
    await expect(executeUpdateRecovery(f.home, job, f.run)).rejects.toThrow('already consumed');
  },
);

it.each(['before-dispatch', 'before-execution'] as const)(
  'observes a healthy connector %s without another start',
  async (when) => {
    const f = await fixture('finished');
    f.running.connectorRunning = when === 'before-dispatch';
    const job = await startUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
    expect(Boolean(job.connector_restart)).toBe(when === 'before-execution');
    f.running.connectorRunning = true;
    await executeUpdateRecovery(f.home, job, f.run);
    expect(f.running.changes).toEqual([]);
    expect(f.store.read()?.phase).toBe('complete');
  },
);

it.each([
  'live-service',
  'live-outgoing',
  'manager-present',
  'manager-error',
  'configuration',
] as const)('refuses restart acceptance with %s evidence', async (failure) => {
  const f = await fixture();
  if (failure === 'live-service') f.running.serviceRunning = true;
  if (failure === 'live-outgoing') {
    if (f.job.connector?.state !== 'running') throw new Error('Missing connector fixture');
    f.job.connector.identity.pid = process.pid;
    atomicPrivateJson(join(f.directory, 'worker.json'), f.job);
  }
  if (failure === 'manager-present')
    vi.spyOn(connectorInspection, 'inspectConnectorManager').mockResolvedValue({
      ...f.replacement.identity,
      t: 'inspection',
      nonce: randomUUID(),
      ready: false,
    });
  if (failure === 'manager-error')
    vi.spyOn(connectorInspection, 'inspectConnectorManager').mockRejectedValue(
      new Error('Inspection unavailable'),
    );
  if (failure === 'configuration') f.running.definition += '\nChanged=yes';
  await expect(startUpdateRecoveryWorker(f.home, f.store.read()!, f.options)).rejects.toThrow();
  expect(f.commands).toEqual([]);
  expect(f.running.changes).toEqual([]);
});

it.each(['configuration', 'live-service'] as const)(
  'rechecks %s after acceptance before any connector mutation',
  async (failure) => {
    const f = await fixture();
    const job = await startUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
    if (failure === 'configuration') f.running.definition += '\nChanged=yes';
    else f.running.serviceRunning = true;
    await expect(executeUpdateRecovery(f.home, job, f.run)).rejects.toThrow();
    expect(f.running.changes).toEqual([]);
    expect(f.store.read()?.phase).toBe('recovery_required');
  },
);

it.each(['lost-reply', 'authority', 'selection', 'manager'] as const)(
  'does not start after resetting a connector limit with changed %s evidence',
  async (failure) => {
    const f = await fixture();
    f.running.failed = true;
    f.running.limited = true;
    f.running.loseResetReply = failure === 'lost-reply';
    const job = await startUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
    f.running.afterReset = () => {
      if (failure === 'authority') f.controller.release();
      if (failure === 'selection') rmSync(join(f.home, 'bin/current'));
      if (failure === 'manager')
        vi.spyOn(connectorInspection, 'inspectConnectorManager').mockResolvedValue({
          ...f.replacement.identity,
          t: 'inspection',
          nonce: randomUUID(),
        });
    };
    await expect(executeUpdateRecovery(f.home, job, f.run)).rejects.toThrow();
    expect(f.running.changes).toEqual(['reset-connector']);
    expect(f.store.read()?.phase).toBe('recovery_required');
  },
);

it('does not turn an observation-only attempt into restart permission after connector loss', async () => {
  const f = await fixture();
  f.running.connectorRunning = true;
  const job = await startUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
  expect(job.connector_restart).toBeUndefined();
  f.running.connectorRunning = false;
  await expect(executeUpdateRecovery(f.home, job, f.run)).rejects.toThrow(
    'not established readiness',
  );
  expect(f.running.changes).toEqual([]);
  expect(f.store.read()?.phase).toBe('recovery_required');
});

it('requires another explicit accepted attempt after a lost start reply and confirmed connector loss', async () => {
  const f = await fixture();
  const job = await startUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
  f.running.loseStartReply = true;
  f.running.afterStart = () => {
    f.running.connectorRunning = false;
  };
  await expect(executeUpdateRecovery(f.home, job, f.run)).rejects.toThrow('start reply lost');
  expect(f.running.changes).toEqual(['start-connector']);
  await expect(executeUpdateRecovery(f.home, job, f.run)).rejects.toThrow('already consumed');
  f.running.loseStartReply = false;
  f.running.afterStart = () => {};
  const next = await startUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
  expect(next.id).not.toBe(job.id);
  expect(next.connector_restart).toBe(job.connector_restart);
  await executeUpdateRecovery(f.home, next, f.run);
  expect(f.running.changes).toEqual(['start-connector', 'start-connector']);
  expect(f.store.read()?.phase).toBe('complete');
});
