import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { hostStageRecordSchema, type HostUpdateCommand } from '@puddle/shared';
import { atomicPrivateJson, digest } from '@puddle/shared/node';
import { acquireHostClaim } from '../../../src/security/claims.js';
import { HostUpdateOperations } from '../../../src/updates/operations/store.js';
import { HostUpdateCoordinator } from '../../../src/updates/coordinator.js';
import { recoverCompletedHostUpdate } from '../../../src/updates/recovery/completion.js';
import { updateWorkerDirectory } from '../../../src/updates/worker/supervisor.js';
import { runtimeRelease } from '../../helpers/runtime-release.js';
import { checkpointWorker } from '../../helpers/update-checkpoint.js';

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(selected = true) {
  const home = mkdtempSync(join(tmpdir(), 'puddle-recovery-'));
  homes.push(home);
  const store = new HostUpdateOperations(home);
  const release = runtimeRelease(home, '0.4.0');
  if (selected) release.select();
  const record = hostStageRecordSchema.parse({
    format: 1,
    component: 'runtime',
    generation: basename(release.release),
    version: '0.4.0',
    protocol: { major: 1, minor: 0 },
    archive_sha256: digest('archive'),
    tree_sha256: digest('tree'),
    checksum_verified: true,
  });
  writeFileSync(join(release.release, '.puddle-stage.json'), JSON.stringify(record), {
    mode: 0o600,
  });
  let operation = store.begin([{ component: 'runtime', version: '0.4.0' }]).operation;
  operation = store.staged(operation, { record, digest: digest(`${JSON.stringify(record)}\n`) });
  operation = store.preflight(operation, digest('approved fixture'));
  operation = store.approve(operation, operation.preflight!);
  const dispatched = store.dispatch(operation);
  const job = checkpointWorker(
    home,
    {
      store,
      operation: dispatched,
      reference: {
        operation_id: dispatched.id,
        dispatch_id: dispatched.dispatch_id!,
        preflight: dispatched.preflight!,
      },
    },
    { pid: 123, controller: { id: randomUUID(), epoch: 1 } },
  );
  const worker = store.claimExecution(dispatched, job.dispatch_id, job.preflight);
  operation = worker.failed('Reply lost after selection');
  worker.release();
  const group = 2147483647;
  expect(() => process.kill(-group, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
  const lifetime = join(updateWorkerDirectory(home, operation.id), 'lifetime.json');
  atomicPrivateJson(lifetime, {
    format: 1,
    operation_id: operation.id,
    dispatch_id: operation.dispatch_id,
    worker_id: operation.worker_id,
    preflight: operation.approved,
    process_group: group,
  });
  const dispatch = vi.fn(async () => {
    throw new Error('Recovery must not dispatch');
  });
  const coordinator = new HostUpdateCoordinator({
    home,
    operations: store,
    inspection: {
      inspect: async () => {
        throw new Error('Recovery must not approve new impact');
      },
    },
    installedRuntime: () => ({ major: 1, minor: 0 }),
    dispatch,
  });
  const command = (): HostUpdateCommand => ({
    action: 'recover',
    reference: { id: store.read()!.id, revision: store.read()!.revision },
    strategy: 'verify-completion',
  });
  return {
    home,
    store,
    operation,
    dispatched,
    job,
    lifetime,
    release,
    dispatch,
    coordinator,
    command,
  };
}

it('completes an exact selected runtime through the coordinator without dispatching and tolerates a lost success reply', async () => {
  const f = fixture();
  const reply = await f.coordinator.execute(f.command(), () => true);
  expect(reply).toMatchObject({
    ok: true,
    operation: { phase: 'complete', verification: expect.stringMatching(/^[a-f0-9]{64}$/) },
  });
  expect(await f.coordinator.execute(f.command(), () => true)).toEqual(reply);
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(() => f.store.claimExecution(f.dispatched, f.job.dispatch_id, f.job.preflight)).toThrow();
});

it('retains incomplete selection and missing lifetime evidence without starting installation', async () => {
  const f = fixture(false);
  expect(await f.coordinator.execute(f.command(), () => true)).toMatchObject({
    ok: false,
    code: 'failed',
    operation: { phase: 'recovery_required' },
  });
  f.release.select();
  rmSync(f.lifetime);
  expect(await f.coordinator.execute(f.command(), () => true)).toMatchObject({
    ok: false,
    code: 'failed',
    operation: { phase: 'recovery_required' },
  });
  expect(f.dispatch).not.toHaveBeenCalled();
});

it.each(['host-update-execution', 'dispatch'])(
  'refuses recovery while %s is still held',
  async (scope) => {
    const f = fixture();
    const claim = acquireHostClaim(
      f.home,
      scope === 'dispatch' ? `host-update-dispatch:${f.operation.id}` : scope,
    );
    try {
      expect(await f.coordinator.execute(f.command(), () => true)).toMatchObject({
        ok: false,
        code: 'conflict',
      });
      expect(f.store.read()).toEqual(f.operation);
    } finally {
      claim.release();
    }
  },
);

it('retains recovery for a live or reused process group and never signals it', async () => {
  const f = fixture();
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  expect(await f.coordinator.execute(f.command(), () => true)).toMatchObject({
    ok: false,
    code: 'failed',
    operation: { phase: 'recovery_required' },
  });
  expect(kill).toHaveBeenCalledExactlyOnceWith(-2147483647, 0);
});

it('holds exclusion across verification and rechecks participating authority before completion', async () => {
  const f = fixture();
  let checks = 0;
  const first = recoverCompletedHostUpdate(f.home, f.operation, () => ++checks < 3);
  await expect(recoverCompletedHostUpdate(f.home, f.operation, () => true)).rejects.toThrow(
    'owns this host claim',
  );
  await expect(first).rejects.toThrow('authority expired');
  expect(f.store.read()?.phase).toBe('recovery_required');
  expect((await recoverCompletedHostUpdate(f.home, f.store.read()!, () => true)).phase).toBe(
    'complete',
  );
});
