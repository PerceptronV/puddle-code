import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { encodeHuddleAgentTarget, type HuddleSpawnOutcome } from '@puddle/shared';
import { spawnMailboxFixture } from '../../../helpers/huddle/spawn-mailbox.js';
import { huddleSpawnReceipt } from '../../../../src/huddle/operations/spawns/receipt.js';
import { huddleBoundSpawn } from '../../../../src/runtime/huddle/operations/spawns/bindings.js';
import { huddleBoundAgent } from '../../../../src/runtime/huddle/operations/bindings.js';
import { huddleRevisionDigest } from '../../../../src/huddle/definitions/revision.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
function fixture(...args: Parameters<typeof spawnMailboxFixture>) {
  const f = spawnMailboxFixture(...args);
  cleanups.push(() => f.close());
  return f;
}
function outcome(f: ReturnType<typeof fixture>, id: string): HuddleSpawnOutcome {
  const operation = f.spawns.describe(id);
  const agent = {
    runtimeId: randomUUID(),
    incarnation: randomUUID(),
    sessionId: randomUUID(),
    projectId: operation.request.projectId,
    worktree: operation.request.worktree,
  };
  return { agent, receipt: huddleSpawnReceipt(operation.scope, operation.request, agent) };
}

it('pins explicit resources and refuses worker-selected defaults, aliases and another scope', () => {
  const f = fixture();
  const message = f.request();
  if (message.action.kind !== 'operation' || message.action.operation.op !== 'spawn')
    throw new Error();
  const options = message.action.operation.options;
  const bind = (overrides: Partial<typeof options>) =>
    huddleBoundSpawn(f.snapshot.components.worker!, f.activation, 'worker', f.identity.project_id, {
      ...options,
      ...overrides,
    });
  expect(bind({})).toMatchObject({ accountId: 1, agent: 'runtime-test', mode: 'headless' });
  expect(bind({ account: 1, mode: undefined, title: undefined })).toMatchObject({
    mode: 'interactive',
    title: 'Script',
  });
  for (const changed of [
    { account: undefined },
    { account: 'personal' },
    { account: '01' },
    { account: 2 },
    { agent: 'another-provider' },
    { project: 'another-project' },
    { worktree: '/other' },
    { worktree: undefined },
    { project: undefined, worktree: undefined, path: f.home },
  ])
    expect(() => bind(changed)).toThrow();
  for (const resource of ['account', 'provider', 'project', 'worktree']) {
    const component = structuredClone(f.snapshot.components.worker!);
    delete component.parameters[resource];
    expect(() =>
      huddleBoundSpawn(component, f.activation, 'worker', f.identity.project_id, options),
    ).toThrow();
  }
  expect(() =>
    huddleBoundSpawn(
      { ...f.snapshot.components.worker!, capabilities: [] },
      f.activation,
      'worker',
      f.identity.project_id,
      options,
    ),
  ).toThrow(/session operations/);
  expect(f.ledger.page('operations')).toEqual([]);
});

it('consumes the execution spawn budget once and never reoffers a lost claim', async () => {
  const f = fixture();
  const first = f.begin(),
    second = f.begin(),
    third = f.begin();
  expect(f.spawns.claim(first.message.id).dispatch).toBe(true);
  expect(f.spawns.claim(first.message.id).dispatch).toBe(false);
  expect(f.spawns.claim(second.message.id).dispatch).toBe(true);
  expect(() => f.spawns.claim(third.message.id)).toThrow(/spawns limit/);
  expect(f.ledger.executions.get(f.invocation.executionId)).toMatchObject({ spawns: 2, turns: 0 });
  for (const waiting of [first, second, third]) waiting.abort.abort(new Error('cancel fixture'));
  await Promise.all(
    [first, second, third].map((w) => expect(w.waiting).rejects.toThrow('cancel fixture')),
  );
  f.reopen();
  expect(f.spawns.claim(first.message.id)).toMatchObject({
    dispatch: false,
    operation: { state: 'unknown' },
  });
  expect(f.spawns.claim(third.message.id)).toMatchObject({
    dispatch: false,
    operation: { state: 'cancelled' },
  });
});

it('retains readiness before resolving the worker and resolves it again after reopening', async () => {
  const f = fixture();
  const waiting = f.begin();
  const operation = f.spawns.claim(waiting.message.id).operation;
  const result = outcome(f, waiting.message.id);
  let acknowledged = false;
  const observed = waiting.waiting.then((handle) => {
    expect(f.ledger.operations.get(waiting.message.id)).toMatchObject({
      state: 'completed',
      result,
    });
    acknowledged = true;
    return handle;
  });
  expect(f.spawns.settle(operation.scope, result)).toEqual(result);
  expect(acknowledged).toBe(false);
  expect(await observed).toEqual({
    runtime_id: result.agent.runtimeId,
    session_id: result.agent.sessionId,
  });
  f.reopen();
  expect(f.spawns.settle(operation.scope, result)).toEqual(result);
  expect(f.spawns.claim(waiting.message.id).dispatch).toBe(false);
  expect(f.spawns.target(f.invocation, result.agent.runtimeId)).toEqual(result.agent);
  await expect(
    f.spawns.request(waiting.message, f.invocation, new AbortController().signal),
  ).rejects.toThrow(/retained operation/);
});

it('does not resolve or expose a handle after failed persistence or mismatched host results', async () => {
  const f = fixture();
  const waiting = f.begin();
  const operation = f.spawns.claim(waiting.message.id).operation;
  const result = outcome(f, waiting.message.id);
  for (const scope of [
    { ...operation.scope, executionId: randomUUID() },
    { ...operation.scope, activationId: randomUUID() },
    { ...operation.scope, owner: { ...operation.scope.owner, incarnation: randomUUID() } },
  ])
    expect(() => f.spawns.settle(scope, result)).toThrow(/retained huddle spawn/);
  for (const agent of [
    { ...result.agent, worktree: '/other' },
    { ...result.agent, projectId: 'aaaaaaaaaa' },
  ]) {
    const receipt = huddleSpawnReceipt(operation.scope, operation.request, agent);
    expect(() => f.spawns.settle(operation.scope, { agent, receipt })).toThrow(/readiness/);
  }
  expect(() => f.spawns.settle(operation.scope, { ...result, receipt: 'b'.repeat(64) })).toThrow(
    /readiness/,
  );
  let resolved = false;
  void waiting.waiting.then(() => {
    resolved = true;
  });
  const write = vi.spyOn(f.ledger.operations, 'settle').mockImplementationOnce(() => {
    throw new Error('Fixture storage failure');
  });
  expect(() => f.spawns.settle(operation.scope, result)).toThrow('Fixture storage failure');
  await Promise.resolve();
  expect(resolved).toBe(false);
  expect(f.spawns.target(f.invocation, result.agent.runtimeId)).toBeNull();
  expect(f.spawns.describe(waiting.message.id).state).toBe('dispatched');
  write.mockRestore();
  f.spawns.settle(operation.scope, result);
  await waiting.waiting;
  expect(() => f.spawns.settle(operation.scope, outcome(f, waiting.message.id))).toThrow(
    /conflicts/,
  );
});

it('keeps unknown creation reconcilable after cancellation without continuing the script', async () => {
  const f = fixture();
  const waiting = f.begin();
  const operation = f.spawns.claim(waiting.message.id).operation;
  const result = outcome(f, waiting.message.id);
  f.ledger.interrupt(f.invocation.executionId, 'cancelled', 'Stop');
  waiting.abort.abort(new Error('Stop'));
  await expect(waiting.waiting).rejects.toThrow('Stop');
  f.reopen();
  expect(f.spawns.describe(waiting.message.id)).toMatchObject({ active: false, state: 'unknown' });
  f.spawns.settle(operation.scope, result);
  expect(f.spawns.describe(waiting.message.id)).toMatchObject({
    active: false,
    state: 'completed',
    result,
  });
  expect(f.ledger.executions.get(f.invocation.executionId).state).toBe('cancelled');
  expect(() => f.spawns.target(f.invocation, result.agent.sessionId)).toThrow();
});

it('shares a retained handle with another invocation only in the same execution and declared worktree', async () => {
  const f = fixture();
  const waiting = f.begin();
  const operation = f.spawns.claim(waiting.message.id).operation;
  const result = outcome(f, waiting.message.id);
  f.spawns.settle(operation.scope, result);
  const handle = await waiting.waiting;
  const downstream = f.invoke(f.invocation.executionId);
  const foreign = f.invoke(f.execution().id);
  for (const reference of [
    result.agent.runtimeId,
    result.agent.sessionId,
    encodeHuddleAgentTarget(result.agent),
  ]) {
    const request = {
      type: 'request' as const,
      id: randomUUID(),
      action: {
        kind: 'operation' as const,
        operation: { op: 'attach' as const, reference },
      },
    };
    expect(await f.asks.request(request, downstream, new AbortController().signal)).toEqual(handle);
    await expect(f.asks.request(request, foreign, new AbortController().signal)).rejects.toThrow(
      /declared agent binding/,
    );
  }
  expect(
    f.spawns.target(downstream, { runtime_id: result.agent.runtimeId, session_id: randomUUID() }),
  ).toBeNull();
  const activation = structuredClone(f.activation);
  activation.bindings.worker!.worktree = '/other';
  expect(() =>
    huddleBoundAgent(
      f.snapshot.components.worker!,
      activation,
      'worker',
      result.agent.runtimeId,
      result.agent,
    ),
  ).toThrow(/declared worktree/);
  const abort = new AbortController();
  const id = randomUUID();
  const ask = f.asks.request(
    {
      type: 'request',
      id,
      action: {
        kind: 'operation',
        operation: {
          op: 'ask',
          handle: { runtime_id: result.agent.runtimeId, session_id: result.agent.sessionId },
          request: { prompt: 'Review' },
        },
      },
    },
    downstream,
    abort.signal,
  );
  const rejected = expect(ask).rejects.toThrow('Fixture ask cancelled');
  expect(f.asks.claim(id)).toMatchObject({
    dispatch: true,
    operation: { scope: { target: result.agent } },
  });
  abort.abort(new Error('Fixture ask cancelled'));
  await rejected;
});

it('pages only spawn records with bounded cursors and rejects an unwaited prepared operation', async () => {
  const f = fixture();
  const waits = Array.from({ length: 18 }, () => f.begin());
  const first = f.spawns.page(0);
  expect(first.records).toHaveLength(16);
  const second = f.spawns.page(first.next);
  expect(second.records).toHaveLength(2);
  expect(
    new Set([...first.records, ...second.records].map((r) => r.operation.scope.operationId)).size,
  ).toBe(18);
  f.reconnect();
  expect(() => f.spawns.claim(waits[0]!.message.id)).toThrow(/no longer awaiting/);
  for (const wait of waits) wait.abort.abort(new Error('End'));
  await Promise.all(waits.map((w) => expect(w.waiting).rejects.toThrow('End')));
});

it('rejects memory exhaustion before intent and releases admission on both cancellation paths', async () => {
  const denied = fixture(undefined, { reserve: () => null });
  await expect(denied.begin().waiting).rejects.toThrow(/memory/);
  expect(denied.ledger.page('operations')).toEqual([]);
  const release = vi.fn();
  const f = fixture(undefined, { reserve: () => release });
  const unsent = f.begin(),
    sent = f.begin();
  const operation = f.spawns.claim(sent.message.id).operation;
  unsent.abort.abort(new Error('Unsent'));
  await expect(unsent.waiting).rejects.toThrow('Unsent');
  f.spawns.unavailable(operation.scope, false, 'Lost host reply');
  await expect(sent.waiting).rejects.toThrow('Lost host reply');
  expect(release).toHaveBeenCalledTimes(2);
  expect(f.spawns.describe(unsent.message.id).state).toBe('cancelled');
  expect(f.spawns.describe(sent.message.id).state).toBe('unknown');
  f.spawns.settle(operation.scope, outcome(f, sent.message.id));
});

it('observes synchronous cancellation during memory admission before offering dispatch', async () => {
  const abort = new AbortController();
  const release = vi.fn();
  const f = fixture(undefined, {
    reserve: () => {
      abort.abort(new Error('Admission revoked'));
      return release;
    },
  });
  const message = f.request();
  await expect(f.spawns.request(message, f.invocation, abort.signal)).rejects.toThrow(
    'Admission revoked',
  );
  expect(f.spawns.claim(message.id)).toMatchObject({
    dispatch: false,
    operation: { state: 'cancelled' },
  });
  expect(release).toHaveBeenCalledOnce();
  expect(f.ledger.executions.get(f.invocation.executionId).spawns).toBe(0);
});

it('keeps an accepted spawn on its captured resource choices after Apply', async () => {
  const f = fixture();
  const waiting = f.begin();
  const before = f.spawns.describe(waiting.message.id);
  const snapshot = structuredClone(f.snapshot);
  snapshot.definition.nodes.find((node) => node.id === 'worker')!.parameters.account = {
    kind: 'literal',
    value: '2',
  };
  snapshot.files['huddle.json'] = JSON.stringify(snapshot.definition);
  snapshot.digest = huddleRevisionDigest(snapshot.files, snapshot.components);
  f.controller.apply(
    snapshot,
    {
      id: randomUUID(),
      worktree: f.home,
      variables: {},
      bindings: { worker: { ...f.bindings, account: '2' } },
    },
    f.ledger.activations.current().generation,
  );
  expect(f.spawns.describe(waiting.message.id)).toEqual(before);
  expect(f.spawns.claim(waiting.message.id).operation.request.accountId).toBe(1);
  f.spawns.settle(before.scope, outcome(f, waiting.message.id));
  await waiting.waiting;
});

it('retains a definite host rejection and never exposes its handle or regrants creation', async () => {
  const f = fixture();
  const waiting = f.begin();
  const operation = f.spawns.claim(waiting.message.id).operation;
  for (const message of ['', 'a'.repeat(4097)]) {
    expect(() => f.spawns.unavailable(operation.scope, true, message)).toThrow();
    expect(f.spawns.describe(waiting.message.id).state).toBe('dispatched');
  }
  f.spawns.unavailable(operation.scope, true, 'Account is no longer logged in');
  await expect(waiting.waiting).rejects.toThrow('Account is no longer logged in');
  f.reopen();
  expect(f.spawns.claim(waiting.message.id)).toMatchObject({
    dispatch: false,
    operation: { state: 'failed', result: { rejected: 'Account is no longer logged in' } },
  });
  expect(() => f.spawns.settle(operation.scope, outcome(f, waiting.message.id))).toThrow(
    /conflicts/,
  );
});
