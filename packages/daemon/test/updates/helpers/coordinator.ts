import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { digest } from '@puddle/shared/node';
import type { HostUpdateCommand, HostUpdateReply, HostUpdateOperation } from '@puddle/shared';
import { HostAdmission } from '../../../src/host/lifecycle/admission.js';
import { HostUpdatePause } from '../../../src/updates/maintenance/pause.js';
import { HostUpdateCoordinator } from '../../../src/updates/coordinator.js';
import type { UpdateInspection } from '../../../src/updates/preflight/inspection.js';
import { candidateFixture } from '../preflight/helpers.js';

export function updateCoordinatorFixture(
  component: 'runtime' | 'daemon' = 'runtime',
  daemonAdmission = false,
  catalogue?: () => import('@puddle/shared').HostUpdateCatalogue,
) {
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
  const repair = vi.fn(async (_operation: HostUpdateOperation, requireAuthority: () => void) => {
    requireAuthority();
  });
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
    inspection: { inspect, prepare: repair },
    installedRuntime: () => f.capabilities.runtime,
    ...(catalogue ? { catalogue } : {}),
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
  const apply = (reply: HostUpdateReply, interruption_approval?: string) => {
    const fingerprint =
      reply.ok && (reply.review?.fingerprint ?? reply.review?.interruption_fingerprint);
    if (!reply.ok || !reply.operation || !fingerprint) throw new Error('no review');
    return execute({
      action: 'apply',
      reference: reply.operation,
      fingerprint,
      ...(interruption_approval !== undefined ? { interruption_approval } : {}),
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
    repair,
    dispatch,
    coordinator,
    revoke: () => {
      allowed = false;
    },
  };
}
