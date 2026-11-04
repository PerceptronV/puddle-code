import { expect, it, vi } from 'vitest';
import { digest } from '@puddle/shared/node';
import type { HostUpdateCommand, HostUpdateReply, HostUpdateOperation } from '@puddle/shared';
import { HostUpdateCoordinator } from '../../src/updates/coordinator.js';
import type { UpdateInspection } from '../../src/updates/preflight/inspection.js';
import { candidateFixture } from './preflight/helpers.js';

function fixture(component: 'runtime' | 'daemon' = 'runtime') {
  const f = candidateFixture(component);
  f.store.stopBeforeDispatch(f.operation, 'cancelled', 'reset fixture');
  let allowed = true;
  const observed: UpdateInspection = {
    fingerprint: digest('inspected exact release and ownership'),
    blockers: [],
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
    async (operation: HostUpdateOperation, _kind: string, authorised: () => boolean) => {
      if (!authorised()) throw new Error('expired');
      f.store.dispatch(operation); // Simulated supervisor dispatch; actual workers have their own suite.
    },
  );
  const coordinator = new HostUpdateCoordinator({
    home: f.home,
    operations: f.store,
    inspection: { inspect },
    installedRuntime: () => f.capabilities.runtime,
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
