import { randomUUID } from 'node:crypto';
import { HostAdmission } from '../../src/host/lifecycle/admission.js';
import { HostUpdatePause } from '../../src/updates/maintenance/pause.js';
import { expect, it, vi } from 'vitest';
import { digest } from '@puddle/shared/node';
import type { HostUpdateCommand, HostUpdateReply, HostUpdateOperation } from '@puddle/shared';
import { HostUpdateCoordinator } from '../../src/updates/coordinator.js';
import type { UpdateInspection } from '../../src/updates/preflight/inspection.js';
import { candidateFixture } from './preflight/helpers.js';

function fixture(component: 'runtime' | 'daemon' = 'runtime', daemonAdmission = false) {
  const f = candidateFixture(component);
  f.store.stopBeforeDispatch(f.operation, 'cancelled', 'reset fixture');
  let allowed = true;
  const observed: UpdateInspection = {
    fingerprint: digest('inspected exact release and ownership'),
    blockers: [],
    connector: {
      state: component === 'daemon' ? 'absent' : 'not-required',
      identity: null,
      blockers: [],
    },
    compatibility: { blockers: [], candidates: [], owners: [], inventory: null },
    capacity: { blockers: [], volumes: [] },
    impact: {
      fingerprint: digest('impact'),
      requiresInterruption: false,
      affected: { terminals: [], notebooks: [], compilation: [], programmes: [] },
    },
    supervision: { worker: { kind: 'systemd', domain: null }, daemon: null, blockers: [] },
  };
  const inspect = vi.fn(async () => observed);
  const dispatch = vi.fn(
    async (
      operation: HostUpdateOperation,
      _kind: string,
      authorised: () => boolean,
      _daemon?: import('@puddle/shared').HostUpdateDaemonHandoff,
    ) => {
      if (!authorised()) throw new Error('expired');
      f.store.dispatch(operation); // Simulated supervisor dispatch; actual workers have their own suite.
    },
  );
  const admission = new HostAdmission();
  const pause = new HostUpdatePause([[admission]]);
  const outgoing = { pid: process.pid, controller: { id: randomUUID(), epoch: 1 } };
  const pauseDaemon = vi.fn(async () => ({ ...(await pause.acquire()), outgoing }));
  if (daemonAdmission)
    observed.supervision.daemon = {
      kind: 'systemd',
      name: 'puddled.service',
      domain: null,
      pid: process.pid,
      invocation: 'a'.repeat(32),
      controlGroup: '/user.slice/puddled.service',
      definition_path: null,
      definition_digest: digest('existing service configuration'),
    };
  const coordinator = new HostUpdateCoordinator({
    home: f.home,
    operations: f.store,
    inspection: { inspect },
    installedRuntime: () => f.capabilities.runtime,
    ...(daemonAdmission ? { pauseDaemon } : {}),
    dispatch,
  });
  const execute = (command: HostUpdateCommand) =>
    coordinator.execute(
      'reference' in command
        ? {
            ...command,
            reference: { id: command.reference.id, revision: command.reference.revision },
          }
        : command,
      () => allowed,
    );
  const prepare = async () => {
    const begun = await execute({ action: 'begin', targets: f.operation.targets });
    if (!begun.ok || !begun.operation) throw new Error('begin failed');
    const staged = await execute({ action: 'stage', reference: begun.operation, receipt: f.stage });
    if (!staged.ok || !staged.operation) throw new Error('stage failed');
    return staged.operation;
  };
  const review = async () => {
    const operation = await prepare();
    return execute({
      action: 'inspect',
      reference: operation,
      cockpit: f.capabilities.application,
    });
  };
  const apply = (reply: HostUpdateReply) => {
    if (!reply.ok || !reply.operation || !reply.review?.fingerprint) throw new Error('no review');
    return execute({
      action: 'apply',
      reference: reply.operation,
      fingerprint: reply.review.fingerprint,
      cockpit: f.capabilities.application,
    });
  };
  return {
    ...f,
    execute,
    prepare,
    review,
    apply,
    observed,
    admission,
    outgoing,
    pauseDaemon,
    inspect,
    dispatch,
    coordinator,
    revoke: () => {
      allowed = false;
    },
  };
}

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
  expect(await f.review()).toMatchObject({
    ok: true,
    review: {
      can_apply: false,
      fingerprint: null,
      blockers: [{ code: 'interruption_approval_required', target: 'daemon' }],
    },
  });
  expect(f.pauseDaemon).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
});
