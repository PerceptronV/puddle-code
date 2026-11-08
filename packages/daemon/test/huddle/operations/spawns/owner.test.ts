import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { HuddleAgentOperation } from '@puddle/shared';
import { spawnOwnerFixture } from '../../../helpers/huddle/spawn-owner.js';
import { until } from '../../../helpers/huddle/controller.js';
import { HuddleAgentSpawns } from '../../../../src/huddle/operations/spawns/service.js';
import { HuddleAgentTurns } from '../../../../src/huddle/operations/turns/service.js';
import { HuddleTurnStore } from '../../../../src/huddle/operations/turns/store.js';

it('runs spawn and prompt through an independent owner after losing the host creation reply', async () => {
  const f = await spawnOwnerFixture();
  try {
    const operation = await f.run();
    expect(
      await f.huddle.request({ t: 'spawn-claim', operationId: operation.scope.operationId }),
    ).toMatchObject({ t: 'spawn-claim', dispatch: true, operation: { state: 'dispatched' } });
    await f.spawns.spawn(
      operation.scope,
      operation.request,
      new AbortController().signal,
      () => true,
    );
    f.huddle.close();
    await f.connect();
    const replacement = new HuddleAgentSpawns(f.deps);
    const result = replacement.observe(operation.scope, operation.request, () => true)!;
    expect(
      await f.huddle.request({ t: 'spawn-claim', operationId: operation.scope.operationId }),
    ).toMatchObject({ dispatch: false });
    expect(
      await f.huddle.request({ t: 'spawn-settle', scope: operation.scope, result }),
    ).toMatchObject({ t: 'spawn-settled', operationId: operation.scope.operationId, result });
    let ask: HuddleAgentOperation | undefined;
    await until(async () => {
      const response = await f.huddle.request({ t: 'operation-page', after: 0 });
      if (response.t !== 'operation-page') throw new Error('No ask page');
      ask = response.page.records[0]?.operation;
      return !!ask;
    });
    expect(ask!.scope.target).toEqual(result.agent);
    expect(
      await f.huddle.request({ t: 'operation-claim', operationId: ask!.scope.operationId }),
    ).toMatchObject({ dispatch: true });
    const turns = new HuddleAgentTurns(f.deps.turns, new HuddleTurnStore(f.db));
    await turns.ask(ask!.scope, ask!.request, new AbortController().signal, () => true);
    const observed = turns.observe(ask!.scope, ask!.request, () => true);
    if (!observed.result || !observed.receipt) throw new Error('No retained turn result');
    await f.huddle.request({
      t: 'operation-settle',
      scope: ask!.scope,
      result: { turn: observed.result, receipt: observed.receipt },
    });
    turns.acknowledge(ask!.scope, ask!.request, observed.receipt, () => true);
    await until(async () => {
      const records = await f.huddle.request({ t: 'records', collection: 'executions', after: 0 });
      return (
        records.t === 'records' &&
        records.rows.some((row) => JSON.parse(row.body).state === 'completed')
      );
    });
    f.huddle.close();
    await f.connect();
    expect(await f.huddle.request({ t: 'spawn-page', after: 0 })).toMatchObject({
      page: { records: [{ operation: { active: false, state: 'completed', result } }] },
    });
    expect(
      await f.huddle.request({ t: 'spawn-settle', scope: operation.scope, result }),
    ).toMatchObject({ result });
    expect(f.supervisorRun).toHaveBeenCalledOnce();
    expect(f.deps.runtimes.get(result.agent.runtimeId)?.state).toBe('running');
    expect(await replacement.cancel(operation.scope, operation.request, () => true)).toEqual({
      state: 'stopped',
    });
    expect(f.db.prepare('SELECT count(*) AS n FROM huddle_runtime_spawns').get()).toEqual({ n: 1 });
  } finally {
    await f.close();
  }
});

it('never regrants a lost claim and distinguishes claimed from unclaimed work on Interrupt', async () => {
  const f = await spawnOwnerFixture();
  try {
    const claimed = await f.run();
    await f.huddle.request({ t: 'spawn-claim', operationId: claimed.scope.operationId });
    const unclaimed = await f.run();
    f.huddle.close();
    await f.connect();
    expect(
      await f.huddle.request({ t: 'spawn-claim', operationId: claimed.scope.operationId }),
    ).toMatchObject({ dispatch: false, operation: { state: 'dispatched' } });
    expect(f.db.prepare('SELECT count(*) AS n FROM huddle_runtime_spawns').get()).toEqual({ n: 0 });
    await f.huddle.request({ t: 'interrupt' });
    for (const [operation, state] of [
      [claimed, 'unknown'],
      [unclaimed, 'cancelled'],
    ] as const) {
      expect(
        await f.huddle.request({ t: 'spawn-claim', operationId: operation.scope.operationId }),
      ).toMatchObject({ dispatch: false, operation: { active: false, state } });
    }
    const response = await f.huddle.request({ t: 'records', collection: 'executions', after: 0 });
    expect(
      response.t === 'records' && response.rows.map((row) => JSON.parse(row.body).spawns),
    ).toEqual([1, 0]);
  } finally {
    await f.close();
  }
});

it('retains late readiness after interruption without continuing a worker or accepting a different scope', async () => {
  const f = await spawnOwnerFixture();
  try {
    const operation = await f.run();
    await f.huddle.request({ t: 'spawn-claim', operationId: operation.scope.operationId });
    const result = await f.spawns.spawn(
      operation.scope,
      operation.request,
      new AbortController().signal,
      () => true,
    );
    await f.huddle.request({ t: 'interrupt' });
    await expect(
      f.huddle.request({
        t: 'spawn-settle',
        scope: { ...operation.scope, activationId: randomUUID() },
        result,
      }),
    ).rejects.toThrow();
    await expect(
      f.huddle.request({
        t: 'spawn-settle',
        scope: operation.scope,
        result: { ...result, receipt: 'b'.repeat(64) },
      }),
    ).rejects.toThrow();
    expect(
      await f.huddle.request({ t: 'spawn-settle', scope: operation.scope, result }),
    ).toMatchObject({ t: 'spawn-settled', result });
    const records = await f.huddle.request({ t: 'records', collection: 'executions', after: 0 });
    expect(
      records.t === 'records' && records.rows.map((row) => JSON.parse(row.body).state),
    ).toEqual(['interrupted']);
    expect(await f.huddle.request({ t: 'operation-page', after: 0 })).toMatchObject({
      page: { records: [] },
    });
    expect(await f.spawns.cancel(operation.scope, operation.request, () => true)).toEqual({
      state: 'stopped',
    });
  } finally {
    await f.close();
  }
});

it('retains unknown and definite host failures through reconnect without retrying creation', async () => {
  const f = await spawnOwnerFixture();
  try {
    const operation = await f.run();
    await f.huddle.request({ t: 'spawn-claim', operationId: operation.scope.operationId });
    await f.huddle.request({
      t: 'spawn-unavailable',
      scope: operation.scope,
      unsent: false,
      error: 'Host outcome unknown',
    });
    f.huddle.close();
    await f.connect();
    expect(await f.huddle.request({ t: 'spawn-page', after: 0 })).toMatchObject({
      page: { records: [{ operation: { state: 'unknown' } }] },
    });
    await f.huddle.request({
      t: 'spawn-unavailable',
      scope: operation.scope,
      unsent: true,
      error: 'Host confirmed no admission',
    });
    expect(
      await f.huddle.request({ t: 'spawn-claim', operationId: operation.scope.operationId }),
    ).toMatchObject({
      dispatch: false,
      operation: { state: 'failed', result: { rejected: 'Host confirmed no admission' } },
    });
    expect(f.db.prepare('SELECT count(*) AS n FROM huddle_runtime_spawns').get()).toEqual({ n: 0 });
  } finally {
    await f.close();
  }
});

it('keeps older owners inspectable while refusing spawn transport and worker operations', async () => {
  const f = await spawnOwnerFixture(false);
  try {
    expect(f.huddle.state?.capabilities.spawns).toBeUndefined();
    await expect(f.huddle.request({ t: 'spawn-page', after: 0 })).rejects.toThrow(/capability/);
    // Bypass only the client guard to exercise the independent server's own capability gate.
    f.huddle.state!.capabilities.spawns = 1;
    await expect(f.huddle.request({ t: 'spawn-page', after: 0 })).rejects.toThrow(/rejected/);
    expect((await f.huddle.request({ t: 'inspect' })).t).toBe('state');
    expect(f.huddle.state?.capabilities.spawns).toBeUndefined();
    await f.admit();
    await until(async () => {
      const records = await f.huddle.request({ t: 'records', collection: 'executions', after: 0 });
      return (
        records.t === 'records' &&
        records.rows.some((row) => JSON.parse(row.body).state === 'failed')
      );
    });
    expect(
      await f.huddle.request({ t: 'records', collection: 'operations', after: 0 }),
    ).toMatchObject({ rows: [] });
    expect(f.db.prepare('SELECT count(*) AS n FROM huddle_runtime_spawns').get()).toEqual({ n: 0 });
  } finally {
    await f.close();
  }
});
