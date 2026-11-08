import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { encodeHuddleAgentTarget, type HuddleWorkerRequest } from '@puddle/shared';
import { HuddleOperationMailbox } from '../../../src/runtime/huddle/operations/mailbox.js';
import { huddleBoundAgent } from '../../../src/runtime/huddle/operations/bindings.js';
import { agentGraphSnapshot } from '../../helpers/huddle/agent-graph.js';
import { huddleLedgerFixture, runningHuddleInvocation } from '../../helpers/huddle/ledger.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

function fixture(admit = true) {
  const f = huddleLedgerFixture();
  cleanups.push(() => f.cleanup());
  f.settings.maxTurns = 1;
  const { invocation } = runningHuddleInvocation(f);
  const target = {
    runtimeId: randomUUID(),
    incarnation: randomUUID(),
    sessionId: randomUUID(),
    projectId: f.identity.projectId,
    worktree: f.home,
  };
  const { snapshot, bindings } = agentGraphSnapshot(f.identity.huddleId, target);
  snapshot.components.coder = snapshot.components.worker!;
  const activation = {
    id: randomUUID(),
    revision: invocation.revision,
    worktree: f.home,
    variables: {},
    bindings: { coder: bindings.worker },
    appliedAt: Date.now(),
  };
  const release = vi.fn();
  const reserve = vi.fn(() => (admit ? release : null));
  const mailbox = new HuddleOperationMailbox(
    {
      runtime_id: f.identity.runtimeId,
      incarnation: randomUUID(),
      launch_id: randomUUID(),
      profile_id: f.identity.profileId,
      project_id: f.identity.projectId,
      session_id: f.identity.sessionId,
      canonical_worktree_path: f.home,
    },
    f.ledger,
    { forExecution: () => ({ activation, snapshot }) },
    () => {},
    { reserve },
  );
  const request = (): HuddleWorkerRequest => ({
    type: 'request',
    id: randomUUID(),
    action: {
      kind: 'operation',
      operation: {
        op: 'ask',
        handle: { runtime_id: target.runtimeId, session_id: target.sessionId },
        request: { prompt: 'review' },
      },
    },
  });
  return {
    ...f,
    invocation,
    target,
    activation,
    component: snapshot.components.coder,
    snapshot,
    mailbox,
    request,
    release,
    reserve,
  };
}

it('accepts only declared session resources in the declared absolute worktree', () => {
  const f = fixture();
  for (const reference of [
    f.target.sessionId,
    f.target.runtimeId,
    encodeHuddleAgentTarget(f.target),
  ])
    expect(huddleBoundAgent(f.component, f.activation, 'coder', reference)).toEqual(f.target);
  expect(() => huddleBoundAgent(f.component, f.activation, 'coder', randomUUID())).toThrow();
  expect(() =>
    huddleBoundAgent(
      { ...f.component, capabilities: [] },
      f.activation,
      'coder',
      f.target.sessionId,
    ),
  ).toThrow();
  for (const worktree of ['', 'relative', '/another-worktree']) {
    const activation = {
      ...f.activation,
      bindings: { coder: { ...f.activation.bindings.coder, worktree } },
    };
    expect(() => huddleBoundAgent(f.component, activation, 'coder', f.target.sessionId)).toThrow();
  }
  const replacement = { ...f.target, incarnation: randomUUID() };
  f.component.parameters.other = f.component.parameters.agent!;
  Object.assign(f.activation.bindings.coder, { other: encodeHuddleAgentTarget(replacement) });
  expect(() => huddleBoundAgent(f.component, f.activation, 'coder', f.target.sessionId)).toThrow(
    /exactly one/,
  );
});

it('refuses memory exhaustion before recording or consuming an agent operation', async () => {
  const f = fixture(false);
  await expect(
    f.mailbox.request(f.request(), f.invocation, new AbortController().signal),
  ).rejects.toThrow(/memory/);
  expect(f.ledger.page('operations', { after: 0 })).toEqual([]);
  expect(f.ledger.executions.get(f.invocation.executionId).turns).toBe(0);
});

it('cancels an unclaimed request and releases its memory without granting a send', async () => {
  const f = fixture();
  const request = f.request();
  const controller = new AbortController();
  const waiting = f.mailbox.request(request, f.invocation, controller.signal);
  const rejected = expect(waiting).rejects.toThrow('cancel fixture');
  controller.abort(new Error('cancel fixture'));
  await rejected;
  expect(f.mailbox.claim(request.id)).toMatchObject({
    dispatch: false,
    operation: { state: 'cancelled' },
  });
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.ledger.executions.get(f.invocation.executionId).turns).toBe(0);
});

it('spends a turn once and rejects a second operation at the root budget', async () => {
  const f = fixture();
  const first = f.request(),
    second = f.request();
  const controller = new AbortController();
  const waits = [first, second].map((request) =>
    expect(f.mailbox.request(request, f.invocation, controller.signal)).rejects.toThrow(
      'cancel fixture',
    ),
  );
  expect(f.mailbox.claim(first.id).dispatch).toBe(true);
  expect(f.mailbox.claim(first.id).dispatch).toBe(false);
  expect(() => f.mailbox.claim(second.id)).toThrow(/turns limit/);
  controller.abort(new Error('cancel fixture'));
  await Promise.all(waits);
  expect(f.ledger.operations.get(first.id).state).toBe('unknown');
  expect(f.ledger.operations.get(second.id).state).toBe('cancelled');
  expect(f.ledger.executions.get(f.invocation.executionId).turns).toBe(1);
  expect(f.release).toHaveBeenCalledTimes(2);
});

it('retains the ask caller across mailbox reconstruction without granting a second dispatch', async () => {
  const f = fixture();
  const request = f.request();
  const abort = new AbortController();
  const rejected = expect(f.mailbox.request(request, f.invocation, abort.signal)).rejects.toThrow(
    'owner lost',
  );
  const claimed = f.mailbox.claim(request.id);
  const scope = claimed.operation.scope;
  abort.abort(new Error('owner lost'));
  await rejected;
  const ledger = f.reopen();
  ledger.recoverOwnerLoss();
  const replacement = { ...scope.owner, incarnation: randomUUID(), launch_id: randomUUID() };
  const mailbox = new HuddleOperationMailbox(
    replacement,
    ledger,
    { forExecution: () => ({ activation: f.activation, snapshot: f.snapshot }) },
    () => {},
  );
  expect(mailbox.describe(request.id).scope).toEqual(scope);
  expect(mailbox.claim(request.id).dispatch).toBe(false);
  expect(() => mailbox.unavailable({ ...scope, owner: replacement }, true, 'unadmitted')).toThrow(
    'match',
  );
  mailbox.unavailable(scope, true, 'unadmitted');
  expect(ledger.operations.get(request.id)).toMatchObject({ state: 'failed', consumed: true });
  expect(ledger.executions.get(f.invocation.executionId).state).toBe('interrupted');
});
