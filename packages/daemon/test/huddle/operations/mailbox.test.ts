import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  encodeHuddleAgentTarget,
  type HuddleWorkerRequest,
  type HuddleCompletionBaseline,
} from '@puddle/shared';
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

it('confirms native feedback in either arrival order without creating another execution or spending another turn', async () => {
  for (const order of ['native-first', 'receipt-first', 'mismatch', 'stop'] as const) {
    const f = fixture();
    f.component.nativeCompletion = 'completion';
    f.component.parameters.completion = {
      schema: { type: 'string' },
      editor: 'text',
      required: true,
    };
    f.snapshot.definition.nodes.push({
      ...f.snapshot.definition.nodes.find((node) => node.id === 'worker')!,
      id: 'coder',
      parameters: {
        worktree: { kind: 'literal', value: f.home },
        agent: { kind: 'literal', value: f.target.sessionId },
        completion: { kind: 'literal', value: 'native' },
      },
    });
    Object.assign(f.activation.bindings, {
      native: { worktree: f.home, session: f.target.sessionId },
    });
    Object.assign(f.activation, f.ledger.activations.apply(f.activation, 0).activation);
    f.ledger.activations.setIntent(1, 'armed', false);
    const baseline: HuddleCompletionBaseline = {
      node: 'native',
      cursor: { epoch: 'a'.repeat(32), sequence: 10 },
      target: {
        identity: {
          runtime_id: f.target.runtimeId,
          incarnation: f.target.incarnation,
          launch_id: randomUUID(),
          profile_id: f.identity.profileId,
          project_id: f.target.projectId,
          session_id: f.target.sessionId,
          canonical_worktree_path: f.home,
        },
        sessionId: f.target.sessionId,
        segmentId: randomUUID(),
        nativeRef: 'native-ref',
      },
    };
    f.ledger.completions.initialise(
      [{ node: 'native', slot: 0, worktree: f.home, session: f.target.sessionId }],
      f.activation,
      [baseline],
    );
    const request = f.request();
    if (request.action.kind !== 'operation' || request.action.operation.op !== 'ask')
      throw new Error('Expected ask');
    request.action.operation.nativeCompletion = true;
    const settled = vi.fn();
    const waiting = f.mailbox.request(request, f.invocation, new AbortController().signal);
    void waiting.then(settled, settled);
    const scope = f.mailbox.claim(request.id).operation.scope;
    const receipt = {
      receipt: 'b'.repeat(64),
      turn: {
        turn: 7,
        status: 'completed' as const,
        expected_ref: 'native-ref',
        reply: 'approved',
      },
    };
    const observe = () => {
      const source = f.ledger.completions.list()[0]!;
      expect(
        f.ledger.completions.admit(
          source,
          {
            state: 'events',
            persistencePending: false,
            head: 11,
            cursor: { ...source.cursor, sequence: 11 },
            records: [
              {
                sequence: 11,
                event: 'completed',
                observedAt: new Date().toISOString(),
                sessionId: f.target.sessionId,
                segmentId: baseline.target.segmentId,
                agentSessionRef: baseline.target.nativeRef,
                nativeTurnId: 'native-turn',
                reply: 'approved',
                origin: {
                  kind: 'automation',
                  turn: order === 'mismatch' ? 8 : 7,
                  huddle: {
                    huddleId: f.identity.huddleId,
                    executionId: f.invocation.executionId,
                    operationId: request.id,
                  },
                },
              },
            ],
          },
          f.settings,
        ),
      ).toBe(0);
      f.mailbox.confirmNative();
    };
    if (order === 'native-first') observe();
    else f.mailbox.settle(scope, receipt);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    if (order === 'native-first') f.mailbox.settle(scope, receipt);
    else if (order === 'stop') f.mailbox.cancelNative();
    else observe();
    if (order === 'mismatch' || order === 'stop')
      await expect(waiting).rejects.toThrow(
        order === 'mismatch' ? 'does not match' : 'stopped or changed',
      );
    else await expect(waiting).resolves.toBe('approved');
    f.mailbox.settle(scope, receipt);
    f.mailbox.confirmNative();
    expect(settled).toHaveBeenCalledOnce();
    expect(f.ledger.page('executions')).toHaveLength(1);
    expect(f.ledger.executions.get(f.invocation.executionId).turns).toBe(1);
    expect(f.mailbox.claim(request.id).dispatch).toBe(false);
  }
});
