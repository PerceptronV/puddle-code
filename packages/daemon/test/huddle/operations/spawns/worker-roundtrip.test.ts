import { expect, it } from 'vitest';
import { prepareHuddleWorkerJob } from '../../../../src/huddle/definitions/worker.js';
import { huddleSpawnServiceFixture } from '../../../helpers/huddle/spawn-service.js';
import { spawnMailboxFixture } from '../../../helpers/huddle/spawn-mailbox.js';
import { workerTestHarness } from '../../../helpers/huddle/worker.js';
import { until } from '../../../helpers/huddle/controller.js';
import { HuddleAgentSpawns } from '../../../../src/huddle/operations/spawns/service.js';
import { HuddleAgentTurns } from '../../../../src/huddle/operations/turns/service.js';
import { HuddleTurnStore } from '../../../../src/huddle/operations/turns/store.js';

const workers = workerTestHarness();

it('returns a retained spawn handle to a real node worker and dispatches its next ask exactly once', async () => {
  const host = huddleSpawnServiceFixture();
  const owner = spawnMailboxFixture({
    home: host.home,
    identity: host.scope.owner,
    huddleId: host.runtimes.get(host.scope.owner.runtime_id)!.huddle_id!,
    accountId: host.request.accountId,
    agent: host.request.agent,
  });
  let worker: ReturnType<typeof workers.start> | undefined;
  try {
    worker = workers.start(
      prepareHuddleWorkerJob(owner.snapshot, owner.invocation, {}, owner.bindings),
      {
        timeoutMs: 30_000,
        request: (message, signal) =>
          message.action.kind === 'operation' && message.action.operation.op === 'spawn'
            ? owner.spawns.request(message, owner.invocation, signal)
            : owner.asks.request(message, owner.invocation, signal),
      },
    );
    await until(() => owner.spawns.page(0).records.length === 1);
    const spawn = owner.spawns.page(0).records[0]!.operation;
    expect(owner.spawns.claim(spawn.scope.operationId).dispatch).toBe(true);
    await host.spawns.spawn(spawn.scope, spawn.request, new AbortController().signal, () => true);
    // The creation reply is lost. A new controller observes the original owner, never creates another.
    const replacement = new HuddleAgentSpawns(host.deps);
    const retained = replacement.observe(spawn.scope, spawn.request, () => true)!;
    expect(owner.spawns.claim(spawn.scope.operationId).dispatch).toBe(false);
    expect(host.run).toHaveBeenCalledOnce();
    expect(owner.spawns.settle(spawn.scope, retained)).toEqual(retained);
    await until(() => owner.asks.page(0).records.length === 1);
    const ask = owner.asks.page(0).records[0]!.operation;
    expect(ask.scope.target).toEqual(retained.agent);
    expect(owner.asks.claim(ask.scope.operationId).dispatch).toBe(true);
    const turns = new HuddleAgentTurns(host.deps.turns, new HuddleTurnStore(host.db));
    await turns.ask(ask.scope, ask.request, new AbortController().signal, () => true);
    const observed = turns.observe(ask.scope, ask.request, () => true);
    if (!observed.result || !observed.receipt) throw new Error('No retained turn outcome');
    owner.asks.settle(ask.scope, { turn: observed.result, receipt: observed.receipt });
    turns.acknowledge(ask.scope, ask.request, observed.receipt, () => true);
    expect(await worker.result).toEqual({ completed: observed.result.reply });
    await worker.exited;
    expect(owner.ledger.executions.get(owner.invocation.executionId)).toMatchObject({
      spawns: 1,
      turns: 1,
    });
    expect(host.run).toHaveBeenCalledOnce();
    expect(await replacement.cancel(spawn.scope, spawn.request, () => true)).toEqual({
      state: 'stopped',
    });
    expect(owner.spawns.settle(spawn.scope, retained)).toEqual(retained);
  } finally {
    worker?.cancel('Fixture closed');
    await worker?.exited;
    owner.close();
    await host.close();
  }
});
