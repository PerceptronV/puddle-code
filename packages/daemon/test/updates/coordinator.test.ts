import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { atomicPrivateJson, digest } from '@puddle/shared/node';
import { checkpointWorker } from '../helpers/update-checkpoint.js';
import { updateWorkerDirectory } from '../../src/updates/worker/supervisor.js';
import { HostUpdateRecoveryAttempts } from '../../src/updates/recovery/worker/records.js';
import { hostUpdateRecoveryJobSchema } from '@puddle/shared';
import { updateCoordinatorFixture as fixture } from './helpers/coordinator.js';

it('coalesces preparation, validates exact stages and reinspects before one durable dispatch', async () => {
  const f = fixture();
  const review = await f.review();
  expect(review).toMatchObject({
    ok: true,
    operation: { phase: 'preflight' },
    review: { can_apply: true },
  });
  expect(await f.execute({ action: 'begin', targets: f.operation.targets })).toMatchObject({
    ok: true,
    created: false,
    operation: { id: review.operation?.id },
  });
  expect(await f.apply(review)).toMatchObject({ ok: true, operation: { phase: 'dispatching' } });
  expect(f.inspect).toHaveBeenCalledTimes(2);
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(await f.apply(review)).toMatchObject({ ok: false, code: 'conflict' });
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it('rejects lost authority after async inspection without committing approval', async () => {
  const f = fixture();
  const operation = await f.prepare();
  f.inspect.mockImplementationOnce(async () => {
    f.revoke();
    return f.observed;
  });
  expect(
    await f.execute({
      action: 'inspect',
      reference: operation,
      cockpit: f.capabilities.application,
    }),
  ).toEqual({ ok: false, code: 'rejected', operation: null });
  expect(f.store.read()?.phase).toBe('staged');
  expect(await f.execute({ action: 'status' })).toEqual({
    ok: false,
    code: 'rejected',
    operation: null,
  });
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('clears stale approval when inspection changes and never dispatches blocked or daemon updates', async () => {
  const f = fixture();
  const review = await f.review();
  f.observed.fingerprint = digest('changed');
  expect(await f.apply(review)).toMatchObject({
    ok: false,
    code: 'conflict',
    operation: { phase: 'preflight', approved: null, preflight: f.observed.fingerprint },
  });
  expect(f.dispatch).not.toHaveBeenCalled();
  const daemon = fixture('daemon');
  expect(await daemon.review()).toMatchObject({
    ok: true,
    operation: { phase: 'blocked' },
    review: { can_apply: false, fingerprint: null },
  });
  expect(daemon.dispatch).not.toHaveBeenCalled();
});

it('retains uncertain dispatch and lets observers inspect without repeating it', async () => {
  const f = fixture();
  const review = await f.review();
  f.dispatch.mockImplementationOnce(async (operation) => {
    f.store.dispatch(operation);
    throw new Error('supervisor reply lost');
  });
  expect(await f.apply(review)).toMatchObject({
    ok: false,
    code: 'failed',
    operation: { phase: 'dispatching' },
  });
  expect(await f.execute({ action: 'status' })).toMatchObject({
    ok: true,
    operation: { phase: 'dispatching' },
  });
  expect(await f.execute({ action: 'begin', targets: f.operation.targets })).toMatchObject({
    ok: true,
    created: false,
    operation: { phase: 'dispatching' },
  });
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it('serialises competing mutations while status remains readable', async () => {
  const f = fixture();
  const operation = await f.prepare();
  let release!: () => void;
  f.inspect.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return f.observed;
  });
  const pending = f.execute({
    action: 'inspect',
    reference: operation,
    cockpit: f.capabilities.application,
  });
  expect(
    await f.execute({ action: 'cancel', reference: operation, reason: 'cancelled' }),
  ).toMatchObject({ ok: false, code: 'conflict' });
  expect(await f.execute({ action: 'status' })).toMatchObject({
    ok: true,
    operation: { phase: 'staged' },
  });
  release();
  expect(await pending).toMatchObject({ ok: true, operation: { phase: 'preflight' } });
});

it('repairs only during authorised staging, never status or review', async () => {
  const f = fixture('daemon', true);
  await f.execute({ action: 'status' });
  expect(f.repair).not.toHaveBeenCalled();
  const operation = await f.prepare();
  expect(f.repair).toHaveBeenCalledOnce();
  await f.execute({ action: 'inspect', reference: operation, cockpit: f.capabilities.application });
  expect(f.repair).toHaveBeenCalledOnce();
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('rejects authority loss during stage repair without dispatching', async () => {
  const f = fixture('daemon', true);
  f.repair.mockImplementationOnce(async (_operation, requireAuthority) => {
    f.revoke();
    requireAuthority();
  });
  await expect(f.prepare()).rejects.toThrow('stage failed');
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.store.read()?.phase).toBe('staged');
});

it('does not accept an unverified receipt or continue after daemon shutdown', async () => {
  const f = fixture();
  const begun = await f.execute({ action: 'begin', targets: f.operation.targets });
  if (!begun.ok || !begun.operation) throw new Error('missing operation');
  expect(
    await f.execute({
      action: 'stage',
      reference: begun.operation,
      receipt: { ...f.stage, digest: 'a'.repeat(64) },
    }),
  ).toMatchObject({ ok: false, code: 'failed' });
  expect(f.store.read()?.stages).toEqual([]);
  expect(f.repair).not.toHaveBeenCalled();
  f.coordinator.close();
  expect(
    await f.execute({ action: 'stage', reference: begun.operation, receipt: f.stage }),
  ).toMatchObject({ ok: false, code: 'rejected' });
});

it('drains daemon admissions before final inspection and retains the hold after accepted dispatch', async () => {
  const f = fixture('daemon', true);
  const review = await f.review();
  expect(f.pauseDaemon).not.toHaveBeenCalled();
  const end = f.admission.enter();
  const applying = f.apply(review);
  expect(() => f.admission.enter()).toThrow();
  expect(f.inspect).toHaveBeenCalledOnce();
  end();
  expect(await applying).toMatchObject({ ok: true, operation: { phase: 'dispatching' } });
  expect(f.inspect).toHaveBeenCalledTimes(2);
  expect(f.dispatch.mock.calls[0]?.[3]).toEqual({
    outgoing: f.outgoing,
    daemon_service: f.observed.supervision.daemon,
    connector: { state: 'absent' },
  });
  expect(() => f.admission.enter()).toThrow();
  const accepted = f.store.read()!;
  const worker = f.store.claimExecution(accepted, accepted.dispatch_id!, accepted.approved!);
  try {
    worker.failed('Replacement requires inspection');
    await f.execute({ action: 'status' });
    expect(() => f.admission.enter()).toThrow(); // Failed phase alone is not proof the worker stopped.
  } finally {
    worker.release();
  }
  await f.execute({ action: 'status' });
  expect(() => f.admission.enter()).toThrow(); // Missing lifetime evidence is not proof of completed cleanup.
  checkpointWorker(
    f.home,
    {
      store: f.store,
      operation: accepted,
      reference: {
        operation_id: accepted.id,
        dispatch_id: accepted.dispatch_id!,
        preflight: accepted.approved!,
      },
    },
    f.outgoing,
  );
  const operation = f.store.read()!;
  const file = join(updateWorkerDirectory(f.home, operation.id), 'lifetime.json');
  const lifetime = {
    format: 1,
    operation_id: operation.id,
    dispatch_id: operation.dispatch_id,
    worker_id: operation.worker_id,
    preflight: operation.approved,
    process_group: 2147483647,
  };
  atomicPrivateJson(file, lifetime);
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  try {
    await f.execute({ action: 'status' });
    expect(() => f.admission.enter()).toThrow();
  } finally {
    kill.mockRestore();
  }
  expect(() => process.kill(-lifetime.process_group, 0)).toThrowError(
    expect.objectContaining({ code: 'ESRCH' }),
  );
  const pending = f.store.claimRecovery(operation);
  const job = hostUpdateRecoveryJobSchema.parse({
    format: 1,
    id: randomUUID(),
    operation_id: operation.id,
    requested_revision: operation.revision,
    revision: pending.operation.revision,
    original_dispatch_id: operation.dispatch_id,
    original_worker_id: operation.worker_id,
    preflight: operation.approved,
    original_worker_digest: digest('worker'),
    actions_digest: digest('actions'),
    service: {
      kind: 'systemd',
      domain: null,
      name: 'puddle-recovery-fixture.service',
      release_path: '/unused/release',
      node_path: '/unused/release/bin/node',
      entry_path: '/unused/release/daemon/host-update.mjs',
      installer_path: '/unused/release/daemon/install.sh',
    },
  });
  const attempts = new HostUpdateRecoveryAttempts(f.home, operation.id);
  try {
    attempts.append(job, () => {});
  } finally {
    pending.release();
  }
  await f.execute({ action: 'status' });
  expect(() => f.admission.enter()).toThrow(); // The pending recovery job can still consume its revision.
  const executing = f.store.claimRecovery(f.store.read()!);
  try {
    attempts.claim(job, 2147483646, () => {});
  } finally {
    executing.release();
  }
  const signal = process.kill.bind(process);
  const recoveryGroup = vi
    .spyOn(process, 'kill')
    .mockImplementation((pid, value) => (pid === -2147483646 ? true : signal(pid, value)));
  try {
    await f.execute({ action: 'status' });
    expect(() => f.admission.enter()).toThrow(); // Recovery-command descendants retain maintenance too.
  } finally {
    recoveryGroup.mockRestore();
  }
  await f.execute({ action: 'status' });
  f.admission.assertOpen();
});

it.each(['authority', 'impact', 'dispatch'] as const)(
  'releases daemon admission after a pre-dispatch %s failure',
  async (failure) => {
    const f = fixture('daemon', true);
    const review = await f.review();
    if (failure === 'authority')
      f.inspect.mockImplementationOnce(async () => {
        f.revoke();
        return f.observed;
      });
    else if (failure === 'impact') f.observed.fingerprint = digest('new runtime appeared');
    else f.dispatch.mockRejectedValueOnce(new Error('Worker could not be prepared'));
    expect(await f.apply(review)).toMatchObject({ ok: false });
    f.admission.assertOpen();
    expect(f.store.read()?.dispatch_id).toBeNull();
  },
);

it('holds daemon admission after a lost dispatch reply until recovery fences the unstarted worker', async () => {
  const f = fixture('daemon', true);
  const review = await f.review();
  f.dispatch.mockImplementationOnce(async (operation) => {
    f.store.dispatch(operation);
    throw new Error('reply lost');
  });
  expect(await f.apply(review)).toMatchObject({ ok: false, code: 'failed' });
  expect(() => f.admission.enter()).toThrow();
  await f.execute({ action: 'status' });
  expect(() => f.admission.enter()).toThrow();
  f.store.requireRecovery(f.store.read()!, 'Confirmed dispatch outcome requires recovery');
  await f.execute({ action: 'status' });
  f.admission.assertOpen();
});

it('does not imply permission to interrupt adjacent work from an update fingerprint', async () => {
  const f = fixture('daemon', true);
  f.observed.impact.requiresInterruption = true;
  const review = await f.review();
  expect(review).toMatchObject({
    ok: true,
    operation: { phase: 'preflight', approved: null },
    review: {
      can_apply: false,
      fingerprint: null,
      interruption_fingerprint: f.observed.fingerprint,
      blockers: [{ code: 'interruption_approval_required', target: 'daemon' }],
    },
  });
  expect(f.pauseDaemon).not.toHaveBeenCalled();
  expect(await f.apply(review)).toMatchObject({
    ok: true,
    operation: { phase: 'preflight', approved: null, dispatch_id: null },
    review: { can_apply: false, interruption_fingerprint: f.observed.fingerprint },
  });
  f.admission.assertOpen();
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('dispatches interruption only with exact consent after drainage and final inspection', async () => {
  const f = fixture('daemon', true);
  f.observed.impact.requiresInterruption = true;
  f.observed.impact.affected.notebooks = [
    {
      instance: randomUUID(),
      revision: 1,
      path: '/project/example.ipynb',
      kernel: 'python3',
      state: 'idle',
      busy: false,
      changing: false,
    },
  ];
  const review = await f.apply(await f.review());
  expect(review).toMatchObject({
    ok: true,
    operation: { phase: 'preflight', approved: null },
    review: { can_apply: false, affected: { notebooks: 1 } },
  });
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(await f.apply(review, f.observed.fingerprint!)).toMatchObject({
    ok: true,
    operation: { phase: 'dispatching' },
  });
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.dispatch.mock.calls[0]?.[3]).toMatchObject({
    interruption_approval: f.observed.fingerprint,
  });
  expect(() => f.admission.assertOpen()).toThrow();
});

it('does not offer interruption consent as a way around other preflight blockers', async () => {
  const f = fixture('daemon', true);
  f.observed.impact.requiresInterruption = true;
  f.observed.fingerprint = null;
  f.observed.blockers.push({ code: 'connector_inventory_changed', target: 'connector' });
  const reply = await f.review();
  expect(reply).toMatchObject({ ok: true, operation: { phase: 'blocked' } });
  expect(reply.ok && reply.review).not.toHaveProperty('interruption_fingerprint');
  expect(f.dispatch).not.toHaveBeenCalled();
});

it.each(['consent', 'inventory', 'authority'] as const)(
  'refuses interruption after changed %s and releases maintenance',
  async (change) => {
    const f = fixture('daemon', true);
    f.observed.impact.requiresInterruption = true;
    const review = await f.review();
    const approval = change === 'consent' ? digest('another approval') : f.observed.fingerprint!;
    if (change === 'inventory') f.observed.fingerprint = digest('another notebook instance');
    if (change === 'authority')
      f.inspect.mockImplementationOnce(async () => {
        f.revoke();
        return f.observed;
      });
    expect(await f.apply(review, approval)).toMatchObject({
      ok: false,
      code: change === 'authority' ? 'rejected' : 'conflict',
    });
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.store.read()?.approved).toBeNull();
    f.admission.assertOpen();
  },
);

it('retains the old blocked review shape for clients without interruption support', async () => {
  const f = fixture('daemon', true);
  f.observed.impact.requiresInterruption = true;
  const operation = await f.prepare();
  const reply = await f.execute({
    action: 'inspect',
    reference: operation,
    cockpit: { major: 25, minor: 9 },
  });
  expect(reply).toMatchObject({
    ok: true,
    operation: { phase: 'blocked' },
    review: { can_apply: false },
  });
  expect(reply.ok && reply.review).not.toHaveProperty('interruption_fingerprint');
  expect(f.dispatch).not.toHaveBeenCalled();
});
