import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@puddle/shared';
import { HostConnection } from '../../../src/lib/auth/connection-authority.js';
import { cockpitUpdatesFixture } from '../../helpers/cockpit-updates.js';
import { presentHostUpdate } from '../../../src/lib/host/updates/presentation.js';

const stage = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/installation/host/staging.js', () => ({ stageHostComponent: stage }));

it('reads status without spending the long-lived cockpit channel request budget', async () => {
  const f = await cockpitUpdatesFixture('ssh');
  const shared = vi
    .spyOn(f.authority, 'hostUpdate')
    .mockRejectedValue(new Error('Host update control limit reached'));
  for (let i = 0; i < 3; i++)
    expect(
      (await f.control.status(undefined, () => true, f.signal.signal)).result?.operation?.id,
    ).toBe(f.operation.id);
  expect(shared).not.toHaveBeenCalled();
  expect(f.authority.state).toBe('ready');
});

it.each(['local', 'ssh'] as const)(
  'prepares, reviews and separately applies through %s host control',
  async (kind) => {
    const f = await cockpitUpdatesFixture(kind);
    vi.stubEnv('PUDDLE_REPO', 'example/client-releases');
    f.store.stopBeforeDispatch(f.operation, 'cancelled', 'fixture preparation');
    stage.mockReset().mockResolvedValue(f.stage);
    const prepared = await f.request({ action: 'prepare', targets: f.operation.targets });
    expect(prepared.operation).toMatchObject({ phase: 'staged', staged: true, dispatched: false });
    expect(stage).toHaveBeenCalledExactlyOnceWith(f.transport, 'daemon', {
      version: '0.4.0',
      repository: 'example/puddle',
    });
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.commands.map(({ action }) => action)).toEqual(['status', 'begin', 'stage']);
    expect(await f.request({ action: 'prepare', targets: f.operation.targets })).toEqual(prepared);
    expect(stage).toHaveBeenCalledOnce();
    const inspected = await f.request({
      action: 'inspect',
      reference: {
        id: prepared.operation!.id,
        revision: prepared.operation!.revision,
      },
    });
    expect(inspected.ok && inspected.review?.can_apply).toBe(true);
    expect(f.dispatch).not.toHaveBeenCalled();
    if (!inspected.ok) throw new Error('Expected review');
    const result = await f.request({
      action: 'apply',
      reference: { id: inspected.operation!.id, revision: inspected.operation!.revision },
      fingerprint: inspected.review!.fingerprint!,
    });
    expect(result.operation?.phase).toBe('complete');
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.authority.state).toBe('ready');
    expect(f.commands.filter(({ action }) => action === 'inspect' || action === 'apply')).toEqual([
      expect.objectContaining({ action: 'inspect', cockpit: PROTOCOL_VERSION }),
      expect.objectContaining({ action: 'apply', cockpit: PROTOCOL_VERSION }),
    ]);
    const publicStatus = await f.control.status(undefined, () => true, f.signal.signal);
    expect(publicStatus.daemon_version).toBe('0.4.37');
    expect(publicStatus.result?.operation?.phase).toBe('complete');
    const text = JSON.stringify(publicStatus);
    for (const hidden of [
      'archive_sha256',
      'tree_sha256',
      'worker_id',
      'dispatch_id',
      'preflight',
      '0.4.0~ABC123',
    ])
      expect(text).not.toContain(hidden);
  },
);

it('does not record a staged receipt after browser revocation during download', async () => {
  const f = await cockpitUpdatesFixture();
  f.store.stopBeforeDispatch(f.operation, 'cancelled', 'fixture preparation');
  stage.mockReset().mockImplementationOnce(async () => {
    f.signal.abort();
    return f.stage;
  });
  await expect(f.request({ action: 'prepare', targets: f.operation.targets })).rejects.toThrow();
  expect(f.commands.map(({ action }) => action)).toEqual(['status', 'begin']);
  expect(f.store.read()?.phase).toBe('downloading');
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('requires separate exact interruption consent and refuses stale review evidence', async () => {
  const f = await cockpitUpdatesFixture();
  f.inspection.impact.requiresInterruption = true;
  f.inspection.impact.affected.notebooks.push({
    instance: randomUUID(),
    revision: 1,
    path: '/private/project.ipynb',
    kernel: 'python3',
    state: 'idle',
    busy: false,
    changing: false,
  });
  const reference = () => ({ id: f.operation.id, revision: f.store.read()!.revision });
  const reviewed = await f.request({ action: 'inspect', reference: reference() });
  if (!reviewed.ok) throw new Error('Expected review');
  const fingerprint = reviewed.review!.interruption_fingerprint!;
  expect(reviewed.review).toMatchObject({ can_apply: false, affected: { notebooks: 1 } });
  const noConsent = await f.request({ action: 'apply', reference: reference(), fingerprint });
  expect(noConsent.operation?.phase).toBe('preflight');
  expect(f.dispatch).not.toHaveBeenCalled();
  f.inspection.fingerprint = 'f'.repeat(64);
  expect(
    await f.request({
      action: 'apply',
      reference: reference(),
      fingerprint,
      interruption_approval: fingerprint,
    }),
  ).toMatchObject({ ok: false, code: 'conflict' });
  expect(f.dispatch).not.toHaveBeenCalled();
  const fresh = await f.request({ action: 'inspect', reference: reference() });
  if (!fresh.ok) throw new Error('Expected fresh review');
  const approval = fresh.review!.interruption_fingerprint!;
  expect(
    await f.request({
      action: 'apply',
      reference: reference(),
      fingerprint: approval,
      interruption_approval: approval,
    }),
  ).toMatchObject({ ok: true, operation: { phase: 'complete' } });
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it('projects blocker codes and aggregate impact without private target paths', async () => {
  const f = await cockpitUpdatesFixture();
  const result = presentHostUpdate({
    ok: true,
    operation: f.operation,
    review: {
      can_apply: false,
      fingerprint: null,
      blockers: [{ code: 'fixture_blocker', target: '/private/worktree' }],
      more_blockers: 1,
      affected: { terminals: 2, notebooks: 1, compilation: 0, programmes: 0 },
    },
  });
  expect(result).toMatchObject({
    review: {
      blockers: [{ code: 'fixture_blocker' }],
      more_blockers: 1,
      affected: { terminals: 2 },
    },
  });
  expect(JSON.stringify(result)).not.toContain('/private/worktree');
});

it.each(['browser', 'parent'] as const)(
  'revokes the pending mutation lease when its %s authority disappears',
  async (which) => {
    const f = await cockpitUpdatesFixture();
    const reviewed = await f.request({
      action: 'inspect',
      reference: { id: f.operation.id, revision: f.operation.revision },
    });
    if (!reviewed.ok) throw new Error('Expected review');
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.inspect.mockImplementationOnce(async () => {
      entered();
      await held;
      return f.inspection;
    });
    const pending = f.request({
      action: 'apply',
      reference: { id: reviewed.operation!.id, revision: reviewed.operation!.revision },
      fingerprint: reviewed.review!.fingerprint!,
    });
    const failed = expect(pending).rejects.toThrow();
    await started;
    if (which === 'browser') f.signal.abort();
    else f.authority.close();
    try {
      await vi.waitFor(() => expect(f.active()).toBe(false));
    } finally {
      release();
    }
    await failed;
    expect(f.store.read()?.phase).toBe('preflight');
    expect(f.dispatch).not.toHaveBeenCalled();
    if (which === 'browser') expect(f.authority.state).toBe('ready');
  },
);

it('observes a committed update after a lost apply reply without another dispatch', async () => {
  const f = await cockpitUpdatesFixture();
  const review = await f.request({
    action: 'inspect',
    reference: { id: f.operation.id, revision: f.operation.revision },
  });
  if (!review.ok) throw new Error('Expected review');
  const original = HostConnection.prototype.hostUpdate;
  vi.spyOn(HostConnection.prototype, 'hostUpdate').mockImplementation(async function (
    this: HostConnection,
    command,
  ) {
    const result = await original.call(this, command);
    if (command.action === 'apply') throw new Error('Lost activation reply');
    return result;
  });
  await expect(
    f.request({
      action: 'apply',
      reference: { id: review.operation!.id, revision: review.operation!.revision },
      fingerprint: review.review!.fingerprint!,
    }),
  ).rejects.toThrow('Lost activation reply');
  expect(
    (await f.control.status(f.operation.id, () => true, f.signal.signal)).result?.operation?.phase,
  ).toBe('complete');
  expect(f.commands.filter(({ action }) => action === 'apply')).toHaveLength(1);
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it.each([6, 7, 10, 11, 12, 13])(
  'capability-detects host application 25.%i without requiring release equality',
  async (minor) => {
    const f = await cockpitUpdatesFixture('local', minor);
    const status = await f.control.status(undefined, () => true, f.signal.signal);
    expect(status.availability).toBe(minor < 7 ? 'upgrade_required' : 'ready');
    expect(status.capabilities).toEqual({
      interruption_approval: minor >= 10,
      verify_completion: minor >= 11,
      continue_recovery: minor >= 12,
    });
    expect(f.commands).toEqual(
      minor < 7 ? [] : [{ action: 'status', ...(minor >= 12 ? { include_recovery: true } : {}) }],
    );
    if (minor < 12) {
      await expect(
        f.request({
          action: 'recover',
          strategy: 'continue',
          reference: { id: f.operation.id, revision: 1 },
        }),
      ).rejects.toThrow();
      expect(f.commands.every(({ action }) => action === 'status')).toBe(true);
    }
  },
);

it('does not open a replacement mutation authority when the cockpit is disconnected', async () => {
  const f = await cockpitUpdatesFixture('ssh');
  f.authority.close();
  const open = vi.spyOn(f.transport, 'openChannel');
  expect((await f.control.status(undefined, () => true, f.signal.signal)).availability).toBe(
    'unavailable',
  );
  await expect(
    f.request({ action: 'cancel', reference: { id: f.operation.id, revision: 1 } }),
  ).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
  expect(f.commands).toEqual([]);
});
