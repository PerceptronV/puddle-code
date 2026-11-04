import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import { hostUpdateActionsSchema } from '@puddle/shared';
import { HostUpdateActions, readUpdateActions } from '../../../src/updates/worker/actions.js';
import { updateWorkerDirectory } from '../../../src/updates/worker/supervisor.js';
import { acceptedCheckpointUpdate, checkpointWorker } from '../../helpers/update-checkpoint.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(component: 'daemon' | 'runtime' = 'runtime') {
  const home = mkdtempSync(join(tmpdir(), 'puddle-update-actions-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const accepted = acceptedCheckpointUpdate(home, component);
  const job = checkpointWorker(home, accepted, {
    pid: process.pid,
    controller: { id: randomUUID(), epoch: 1 },
  });
  const worker = accepted.store.claimExecution(accepted.operation, job.dispatch_id, job.preflight);
  cleanups.push(() => worker.release());
  const read = () => readUpdateActions(home, job, accepted.store.read()!);
  return {
    home,
    job,
    worker,
    read,
    store: accepted.store,
    path: join(updateWorkerDirectory(home, job.operation_id), 'actions.json'),
  };
}

it('durably records intent before execution and refuses an attempted step or a second journal', async () => {
  const f = fixture();
  const actions = new HostUpdateActions(f.home, f.job);
  const execute = vi.fn(async () => {
    expect(f.read().actions).toEqual([{ action: 'select-runtime', state: 'started' }]);
    throw new Error('selection reply lost');
  });
  await expect(actions.run('select-runtime', execute)).rejects.toThrow('reply lost');
  await expect(actions.run('select-runtime', execute)).rejects.toThrow('already attempted');
  expect(() => new HostUpdateActions(f.home, f.job)).toThrow('already recorded');
  expect(execute).toHaveBeenCalledTimes(1);
  expect(f.read().actions[0]!.state).toBe('started');
});

it.each(['before-intent', 'after-intent', 'before-finish', 'after-finish'] as const)(
  'preserves command uncertainty when durable storage fails %s',
  async (failure) => {
    const f = fixture();
    let writes = 0;
    const actions = new HostUpdateActions(f.home, f.job, (path, record, options) => {
      expect(options?.syncDirectory).toBe(true);
      const failing = ++writes === (failure.endsWith('intent') ? 2 : 3);
      if (failing && failure.startsWith('before')) throw new Error('storage unavailable');
      atomicPrivateJson(path, record, options);
      if (failing) throw new Error('storage acknowledgement lost');
    });
    const execute = vi.fn(async () => {});
    await expect(actions.run('select-runtime', execute)).rejects.toThrow('storage');
    expect(execute).toHaveBeenCalledTimes(failure.endsWith('intent') ? 0 : 1);
    expect(f.read().actions[0]!.state).toBe(
      failure === 'before-intent' ? 'planned' : failure === 'after-finish' ? 'finished' : 'started',
    );
    expect(() => new HostUpdateActions(f.home, f.job)).toThrow('already recorded');
  },
);

it('requires the exact planned order and phase, and stops after execution ownership changes', async () => {
  const f = fixture('daemon');
  const actions = new HostUpdateActions(f.home, f.job);
  const execute = vi.fn(async () => {});
  await expect(actions.run('select-daemon', execute)).rejects.toThrow('out of order');
  expect(execute).not.toHaveBeenCalled();
  for (const action of ['stop-connector', 'stop-daemon', 'select-daemon'] as const)
    await actions.run(action, execute);
  await expect(actions.run('start-daemon', execute)).rejects.toThrow('executing update');
  f.worker.verifying();
  await actions.run('start-daemon', execute);
  await actions
    .run('start-connector', async () => {
      f.worker.failed('ownership changed during observation');
    })
    .then(
      () => {
        throw new Error('Unexpected completion');
      },
      (error: Error) => {
        expect(error.message).toContain('executing update');
      },
    );
  expect(f.read().actions.at(-1)!.state).toBe('started');
  await expect(actions.run('start-connector', execute)).rejects.toThrow('executing update');
});

it('refuses missing, mismatched, reordered and corrupt journals as recovery evidence', () => {
  const f = fixture('daemon');
  expect(() => f.read()).toThrow();
  new HostUpdateActions(f.home, f.job);
  const original = f.read();
  for (const changed of [
    { ...original, worker_id: randomUUID() },
    { ...original, dispatch_id: randomUUID() },
    { ...original, preflight: '0'.repeat(64) },
    { ...original, actions: original.actions.toReversed() },
    { ...original, actions: original.actions.slice(1) },
    {
      ...original,
      actions: original.actions.map((action, i) => ({
        ...action,
        state: i === 1 ? 'finished' : 'planned',
      })),
    },
  ]) {
    atomicPrivateJson(f.path, changed);
    expect(() => f.read()).toThrow();
  }
  expect(
    hostUpdateActionsSchema.safeParse({
      ...original,
      actions: [original.actions[0], original.actions[0]],
    }).success,
  ).toBe(false);
  writeFileSync(f.path, ' '.repeat(4097));
  expect(() => f.read()).toThrow();
  writeFileSync(f.path, '{');
  expect(() => new HostUpdateActions(f.home, f.job)).toThrow();
});
