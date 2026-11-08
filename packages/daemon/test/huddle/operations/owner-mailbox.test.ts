import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { readRuntimeJson } from '../../../src/runtime/ownership/storage.js';
import { agentOwnerFixture } from '../../helpers/huddle/agent-owner.js';
import { until } from '../../helpers/huddle/controller.js';

it('routes a real worker ask through agent admission and saves the outcome before acknowledging its host receipt', async () => {
  const f = await agentOwnerFixture();
  try {
    const operation = await f.run('review this graph');
    expect(operation).toMatchObject({
      state: 'prepared',
      active: true,
      scope: { owner: f.launch.identity },
    });
    expect(f.db.prepare('SELECT * FROM huddle_runtime_turns').all()).toEqual([]);
    const result = await f.execute(operation);
    expect(f.db.prepare('SELECT consumed FROM runtime_turns').get()).toEqual({ consumed: 0 });
    const settled = await f.huddle.request({
      t: 'operation-settle',
      scope: operation.scope,
      result,
    });
    expect(settled).toMatchObject({ t: 'operation-settled', result });
    // The daemon may release retention only after this durable owner response.
    f.turns.acknowledge(operation.scope, operation.request, result.receipt, () => true);
    await until(async () => {
      const rows = await f.huddle.request({ t: 'records', collection: 'executions', after: 0 });
      return (
        rows.t === 'records' && rows.rows.some(({ body }) => JSON.parse(body).state === 'completed')
      );
    });
    const page = await f.huddle.request({ t: 'operation-page', after: 0 });
    expect(page).toMatchObject({
      t: 'operation-page',
      page: { records: [{ operation: { state: 'completed', result } }] },
    });
    expect(f.db.prepare('SELECT consumed FROM runtime_turns').get()).toEqual({ consumed: 1 });
    expect(readRuntimeJson(join(f.home, `${f.session.id}.turns.json`))).toMatchObject({ count: 1 });
  } finally {
    await f.close();
  }
});

it('keeps a worker waiting through controller disconnect and never reoffers a consumed claim after a lost reply', async () => {
  const f = await agentOwnerFixture();
  try {
    const operation = await f.run('no duplicate');
    f.huddle.close();
    await f.connect();
    const grant = await f.huddle.request({
      t: 'operation-claim',
      operationId: operation.scope.operationId,
    });
    expect(grant).toMatchObject({ t: 'operation-claim', dispatch: true });
    // Lose this grant before host dispatch. Neither reconnect nor another claim grants a second send.
    f.huddle.close();
    await f.connect();
    const repeated = await f.huddle.request({
      t: 'operation-claim',
      operationId: operation.scope.operationId,
    });
    expect(repeated).toMatchObject({
      t: 'operation-claim',
      dispatch: false,
      operation: { state: 'dispatched' },
    });
    expect(f.db.prepare('SELECT * FROM huddle_runtime_turns').all()).toEqual([]);
    expect(existsSync(join(f.home, `${f.session.id}.turns.json`))).toBe(false);
    await f.huddle.request({ t: 'interrupt' });
    const page = await f.huddle.request({ t: 'operation-page', after: 0 });
    expect(page).toMatchObject({
      page: { records: [{ operation: { active: false, state: 'unknown' } }] },
    });
  } finally {
    await f.close();
  }
});

it('reobserves a saved settlement after disconnect and refuses conflicting or incorrectly scoped outcomes', async () => {
  const f = await agentOwnerFixture();
  try {
    const operation = await f.run('retain receipt');
    const result = await f.execute(operation);
    await expect(
      f.huddle.request({
        t: 'operation-settle',
        scope: { ...operation.scope, activationId: randomUUID() },
        result,
      }),
    ).rejects.toThrow();
    await f.huddle.request({ t: 'operation-settle', scope: operation.scope, result });
    f.huddle.close();
    await f.connect();
    const again = await f.huddle.request({ t: 'operation-settle', scope: operation.scope, result });
    expect(again).toMatchObject({ t: 'operation-settled', result });
    await expect(
      f.huddle.request({
        t: 'operation-settle',
        scope: operation.scope,
        result: { ...result, receipt: 'b'.repeat(64) },
      }),
    ).rejects.toThrow();
    f.turns.acknowledge(operation.scope, operation.request, result.receipt, () => true);
    expect(readRuntimeJson(join(f.home, `${f.session.id}.turns.json`))).toMatchObject({ count: 1 });
  } finally {
    await f.close();
  }
});

it('records late results after interruption without completing the interrupted graph', async () => {
  const f = await agentOwnerFixture();
  try {
    const operation = await f.run('late outcome');
    const result = await f.execute(operation);
    await f.huddle.request({ t: 'interrupt' });
    await f.huddle.request({ t: 'operation-settle', scope: operation.scope, result });
    const rows = await f.huddle.request({ t: 'records', collection: 'executions', after: 0 });
    expect(rows.t === 'records' && rows.rows.map(({ body }) => JSON.parse(body).state)).toEqual([
      'interrupted',
    ]);
    f.turns.acknowledge(operation.scope, operation.request, result.receipt, () => true);
  } finally {
    await f.close();
  }
});

it('adopts an owner without the optional operation capability and refuses mailbox commands', async () => {
  const f = await agentOwnerFixture(true);
  try {
    expect(f.huddle.state?.capabilities.operations).toBeUndefined();
    await expect(f.huddle.request({ t: 'operation-page', after: 0 })).rejects.toThrow();
    expect((await f.huddle.request({ t: 'inspect' })).t).toBe('state');
  } finally {
    await f.close();
  }
});
