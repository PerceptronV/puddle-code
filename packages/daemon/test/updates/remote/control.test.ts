import { expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  hostMaintenanceCommandSchema,
  type HostMaintenanceCommand,
  type HostMaintenanceReply,
  type HostUpdateCatalogue,
  type HostUpdateCommand,
} from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import { RemoteHostUpdates } from '../../../src/updates/remote/control.js';
import { updateCoordinatorFixture } from '../helpers/coordinator.js';

function fixture(component: 'runtime' | 'daemon' = 'runtime') {
  const catalogue: HostUpdateCatalogue = {
    observed_at: 1000,
    daemon_version: '0.4.0',
    runtime_default: { version: '0.4.0', protocol: { major: 1, minor: 0 } },
    runtimes: {
      complete: true,
      versions: [
        {
          version: '0.4.0',
          protocol: { major: 1, minor: 0 },
          running: 3,
          starting: 1,
          unavailable: 2,
        },
      ],
    },
    releases: {
      repository: 'private-owner/host-release',
      state: 'ready',
      checked_at: 1000,
      succeeded_at: 1000,
      latest: { version: '0.4.1', host_asset: true },
    },
  };
  const f = updateCoordinatorFixture(component, component === 'daemon', () => catalogue);
  const authority = { grant: true, lease: true };
  const authorised = () => authority.grant && authority.lease;
  const execute = vi.fn((command: HostUpdateCommand, current: () => boolean) =>
    f.coordinator.execute(command, current),
  );
  const stage = vi.fn(
    async (
      _repository: string,
      _target: (typeof f.operation.targets)[number],
      _current: () => boolean,
    ) => f.stage,
  );
  const remote = new RemoteHostUpdates({ version: '0.4.0', execute, stage });
  const call = (command: HostMaintenanceCommand) => remote.execute(command, authorised);
  const prepare = () => call({ action: 'prepare', targets: f.operation.targets });
  return {
    ...f,
    authority,
    catalogue,
    remote,
    call,
    prepareRemote: prepare,
    executeRemote: execute,
    stageRemote: stage,
  };
}
function result(reply: HostMaintenanceReply) {
  if (reply.kind !== 'result') throw new Error('Expected update result');
  return reply.result;
}
function reference(reply: HostMaintenanceReply) {
  const operation = result(reply).operation;
  if (!operation) throw new Error('Expected durable operation');
  return { id: operation.id, revision: operation.revision };
}
async function reviewed(f: ReturnType<typeof fixture>) {
  const prepared = await f.prepareRemote();
  return f.call({ action: 'inspect', reference: reference(prepared) });
}

it('coalesces two callers through the real coordinator and lets only the begin winner stage', async () => {
  const f = fixture();
  let release!: () => void;
  f.stageRemote.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return f.stage;
  });
  const first = f.prepareRemote();
  await vi.waitFor(() => expect(f.stageRemote).toHaveBeenCalledOnce());
  const second = await f.prepareRemote();
  expect(result(second).operation?.phase).toBe('downloading');
  expect(f.stageRemote).toHaveBeenCalledOnce();
  release();
  const completed = await first;
  expect(result(completed).operation).toMatchObject({
    id: result(second).operation?.id,
    phase: 'staged',
    staged: true,
  });
  expect(f.store.read()?.stages).toEqual([f.stage]);
  expect(f.stageRemote.mock.calls[0]?.slice(0, 2)).toEqual([
    'private-owner/host-release',
    f.operation.targets[0],
  ]);
  expect(f.executeRemote.mock.calls.filter(([command]) => command.action === 'begin')).toHaveLength(
    2,
  );
  expect(f.executeRemote.mock.calls.filter(([command]) => command.action === 'stage')).toHaveLength(
    1,
  );
});

it('rejects browser-selected sources, receipts, identities and offline commands before entering the coordinator', async () => {
  const f = fixture();
  for (const value of [
    { action: 'prepare', targets: f.operation.targets, repository: 'attacker/release' },
    { action: 'prepare', targets: f.operation.targets, path: '/private/installer' },
    { action: 'prepare', targets: f.operation.targets, maintenance: { device: 'attacker' } },
    {
      action: 'stage',
      reference: { id: f.operation.id, revision: f.operation.revision },
      receipt: f.stage,
    },
    {
      action: 'continue-offline',
      reference: { id: f.operation.id, revision: f.operation.revision },
    },
  ]) {
    expect(hostMaintenanceCommandSchema.safeParse(value).success).toBe(false);
    await expect(f.call(value as HostMaintenanceCommand)).rejects.toThrow();
  }
  expect(f.executeRemote).not.toHaveBeenCalled();
  expect(f.stageRemote).not.toHaveBeenCalled();
  f.catalogue.releases.repository = null;
  await expect(f.prepareRemote()).rejects.toThrow('No host release source');
  expect(f.executeRemote.mock.calls.map(([command]) => command.action)).toEqual(['status']);
});

it('presents aggregate catalogue and redacts private operation messages, stage evidence and blocker paths', async () => {
  const f = fixture();
  f.observed.fingerprint = null;
  f.observed.blockers = [{ code: 'candidate_unavailable', target: '/private/project/secrets' }];
  const reply = result(await reviewed(f));
  expect(reply.ok && reply.review?.blockers).toEqual([{ code: 'candidate_unavailable' }]);
  expect(reply.operation?.message).toBeNull();
  const status = await f.call({ action: 'status' });
  expect(status).toMatchObject({
    kind: 'status',
    status: {
      capabilities: {
        continue_recovery: true,
        verify_completion: true,
        offline_continuation: false,
      },
      catalogue: { releases: { repository: null }, runtimes: f.catalogue.runtimes },
      result: { operation: { message: null } },
    },
  });
  const publicJson = JSON.stringify([reply, status]);
  for (const value of [
    '/private/project/secrets',
    'private-owner/host-release',
    f.stage.digest,
    f.stage.record.generation,
    f.home,
    'Host update checks did not pass',
  ])
    expect(publicJson).not.toContain(value);
  expect(f.store.read()?.message).toBe('Host update checks did not pass');
});

it('uses the same exact interruption review and apply approval without inventing remote consent', async () => {
  const f = fixture('daemon');
  f.observed.impact.requiresInterruption = true;
  const inspected = await reviewed(f);
  expect(result(inspected)).toMatchObject({
    ok: true,
    review: { can_apply: false, interruption_fingerprint: f.observed.fingerprint },
  });
  const missing = await f.call({
    action: 'apply',
    reference: reference(inspected),
    fingerprint: f.observed.fingerprint!,
  });
  expect(result(missing)).toMatchObject({ ok: true, review: { can_apply: false } });
  expect(f.dispatch).not.toHaveBeenCalled();
  const wrong = await f.call({
    action: 'apply',
    reference: reference(missing),
    fingerprint: f.observed.fingerprint!,
    interruption_approval: digest('another review'),
  });
  expect(result(wrong)).toMatchObject({ ok: false, code: 'conflict' });
  expect(f.dispatch).not.toHaveBeenCalled();
  const accepted = await f.call({
    action: 'apply',
    reference: reference(wrong),
    fingerprint: f.observed.fingerprint!,
    interruption_approval: f.observed.fingerprint!,
  });
  expect(result(accepted)).toMatchObject({ ok: true, operation: { dispatched: true } });
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.dispatch.mock.calls[0]?.[3]?.interruption_approval).toBe(f.observed.fingerprint);
  const submitted = f.executeRemote.mock.calls.at(-1)?.[0];
  expect(submitted).toMatchObject({
    action: 'apply',
    cockpit: PROTOCOL_VERSION,
    interruption_approval: f.observed.fingerprint,
  });
});

it.each(['grant', 'lease'] as const)(
  'does not record a stage after %s revocation during preparation',
  async (scope) => {
    const f = fixture();
    f.stageRemote.mockImplementationOnce(async () => {
      f.authority[scope] = false;
      return f.stage;
    });
    await expect(f.prepareRemote()).rejects.toThrow();
    expect(f.store.read()).toMatchObject({ phase: 'downloading', stages: [], dispatch_id: null });
    expect(f.executeRemote.mock.calls.map(([command]) => command.action)).toEqual([
      'status',
      'begin',
    ]);
    expect(f.dispatch).not.toHaveBeenCalled();
  },
);

it.each(['grant', 'lease'] as const)(
  'does not commit review or dispatch after %s revocation during preflight',
  async (scope) => {
    const f = fixture();
    const prepared = await f.prepareRemote();
    f.inspect.mockImplementationOnce(async () => {
      f.authority[scope] = false;
      return f.observed;
    });
    await expect(f.call({ action: 'inspect', reference: reference(prepared) })).rejects.toThrow(
      'authority expired',
    );
    expect(f.store.read()).toMatchObject({
      phase: 'staged',
      approved: null,
      preflight: null,
      dispatch_id: null,
    });
    f.authority[scope] = true;
    const inspected = await f.call({ action: 'inspect', reference: reference(prepared) });
    f.inspect.mockImplementationOnce(async () => {
      f.authority[scope] = false;
      return f.observed;
    });
    await expect(
      f.call({
        action: 'apply',
        reference: reference(inspected),
        fingerprint: f.observed.fingerprint!,
      }),
    ).rejects.toThrow('authority expired');
    expect(f.store.read()).toMatchObject({ approved: null, dispatch_id: null });
    expect(f.dispatch).not.toHaveBeenCalled();
  },
);

it.each(['begin', 'stage'] as const)(
  'observes a committed %s after its reply is lost without repeating preparation',
  async (lost) => {
    const f = fixture();
    let dropped = false;
    f.executeRemote.mockImplementation(async (command, current) => {
      const reply = await f.coordinator.execute(command, current);
      if (command.action === lost && !dropped) {
        dropped = true;
        throw new Error('Reply lost');
      }
      return reply;
    });
    await expect(f.prepareRemote()).rejects.toThrow('Reply lost');
    const accepted = f.store.read()!;
    expect(accepted.phase).toBe(lost === 'begin' ? 'downloading' : 'staged');
    expect(await f.call({ action: 'status' })).toMatchObject({
      kind: 'status',
      status: { result: { operation: { id: accepted.id, phase: accepted.phase } } },
    });
    expect(result(await f.prepareRemote()).operation?.id).toBe(accepted.id);
    expect(f.stageRemote).toHaveBeenCalledTimes(lost === 'begin' ? 0 : 1);
    expect(f.dispatch).not.toHaveBeenCalled();
  },
);

it('observes accepted dispatch after a lost reply and never repeats the worker', async () => {
  const f = fixture();
  const inspected = await reviewed(f);
  f.dispatch.mockImplementationOnce(async (operation) => {
    f.store.dispatch(operation);
    throw new Error('Private supervisor path /secret/release lost reply');
  });
  const command: HostMaintenanceCommand = {
    action: 'apply',
    reference: reference(inspected),
    fingerprint: f.observed.fingerprint!,
  };
  const failed = await f.call(command);
  expect(result(failed)).toMatchObject({
    ok: false,
    code: 'failed',
    operation: { dispatched: true, phase: 'dispatching', message: null },
  });
  expect(await f.call({ action: 'status' })).toMatchObject({
    kind: 'status',
    status: { result: { operation: { dispatched: true, phase: 'dispatching' } } },
  });
  expect(result(await f.call(command))).toMatchObject({ ok: false, code: 'conflict' });
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it.each(['continue', 'verify-completion'] as const)(
  'delegates explicit %s recovery to the coordinator while offline continuation stays excluded',
  async (strategy) => {
    const f = fixture();
    const prepared = await f.prepareRemote();
    const command = { action: 'recover', reference: reference(prepared), strategy } as const;
    expect(hostMaintenanceCommandSchema.safeParse(command).success).toBe(true);
    await f.call(command);
    expect(f.executeRemote.mock.calls.at(-1)?.[0]).toEqual(command);
    expect(
      hostMaintenanceCommandSchema.safeParse({
        action: 'continue-offline',
        reference: command.reference,
      }).success,
    ).toBe(false);
    expect(f.stageRemote).toHaveBeenCalledOnce();
    expect(f.dispatch).not.toHaveBeenCalled();
  },
);
