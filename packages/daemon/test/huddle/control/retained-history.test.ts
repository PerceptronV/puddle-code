import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { huddleHistoryOwnersSchema, huddleRetainedHistorySchema } from '@puddle/shared';
import { huddleExecutionFixture as fixture } from '../../helpers/huddle/execution.js';
import { until } from '../../helpers/huddle/controller.js';

it('reads results after Stop and source removal without relaunch, adoption or public private fields', async () => {
  const f = await fixture();
  try {
    expect(
      huddleHistoryOwnersSchema.parse((await f.request('history/owners', {})).body).records,
    ).toEqual([]);
    const started = await f.request('start', {
      expected_digest: (await f.source()).digest,
      variables: {},
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const target = started.body.owner.target;
    const owner = { runtimeId: target.runtimeId, incarnation: target.incarnation };
    const run = await f.request('run', {
      target,
      node: 'run',
      event_id: randomUUID(),
      data: f.home,
    });
    expect(run.status).toBe(200);
    await until(() => readdirSync(f.home).includes('entered'));
    writeFileSync(join(f.home, 'release'), 'go');
    const query = { owner, collection: 'executions', after: 0 };
    await until(
      async () =>
        (await f.request('history', query)).body.records?.[0]?.record.state === 'completed',
    );
    expect((await f.request('stop', { target })).status).toBe(200);
    rmSync(f.root, { recursive: true });
    expect((await f.request('runtime')).body.owner).toBeNull();
    const runtimes = huddleHistoryOwnersSchema.parse((await f.request('history/owners', {})).body);
    expect(runtimes.records[0]).toMatchObject({ owner, recorded_state: 'exited' });
    const directory = join(f.home, 'runtimes', owner.runtimeId);
    const bytes = readFileSync(join(directory, 'huddle.sqlite'));
    const names = readdirSync(directory);
    const inspect = vi.spyOn(f.controls.huddles, 'inspect');
    const recorded = await f.request('history/retained', query);
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
    const result = huddleRetainedHistorySchema.parse(recorded.body);
    expect(result.history.records[0]?.record).toMatchObject({
      id: run.body.executionId,
      state: 'completed',
    });
    expect(result.history.records[0]?.record).not.toHaveProperty('limits');
    const nodes = await f.request('history/retained', {
      ...query,
      collection: 'invocations',
      parent: run.body.executionId,
    });
    expect(nodes.status).toBe(200);
    expect(
      nodes.body.history.records.some(
        (row: { record: { result?: unknown } }) => row.record.result !== undefined,
      ),
    ).toBe(true);
    expect(nodes.body.history.records[0].record).not.toHaveProperty('activation');
    expect(readFileSync(join(directory, 'huddle.sqlite'))).toEqual(bytes);
    expect(readdirSync(directory)).toEqual(names);
    expect(inspect).not.toHaveBeenCalled();
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(
      (await f.request('history/retained', { ...query, include_readout_observation: true })).status,
    ).toBe(200);
    expect(
      (
        await f.request('history/retained', {
          ...query,
          owner: { ...owner, incarnation: randomUUID() },
        })
      ).body.error.code,
    ).toBe('huddle_history_changed');
    expect(
      (
        await f.request('history/retained', {
          ...query,
          owner: { ...owner, runtimeId: randomUUID() },
        })
      ).status,
    ).toBe(409);
    f.remote();
    expect((await f.request('history/owners', {})).status).toBe(403);
    expect((await f.request('history/retained', query)).status).toBe(403);
  } finally {
    await f.close();
  }
});

it('bounds catalogue pages and refuses revoked readers before private inspection', async () => {
  const f = await fixture();
  try {
    const started = await f.request('start', {
      expected_digest: (await f.source()).digest,
      variables: {},
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const target = started.body.owner.target;
    expect((await f.request('stop', { target })).status).toBe(200);
    const original = f.runtimes.get(target.runtimeId)!;
    const columns = Object.keys(original);
    const insert = f.db.prepare(
      `INSERT INTO runtime_bindings (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
    );
    for (let index = 0; index < 68; index++) {
      const record = {
        ...original,
        runtime_id: randomUUID(),
        incarnation: randomUUID(),
        launch_id: randomUUID(),
        launch_fingerprint: randomUUID(),
      };
      insert.run(...columns.map((column) => record[column as keyof typeof record]));
    }
    const first = huddleHistoryOwnersSchema.parse((await f.request('history/owners', {})).body);
    expect(first.records).toHaveLength(64);
    const second = huddleHistoryOwnersSchema.parse(
      (await f.request('history/owners', { after: first.next })).body,
    );
    expect(second.records).toHaveLength(5);
    expect(second.next).toBeNull();
    expect(
      new Set([...first.records, ...second.records].map((record) => record.owner.runtimeId)).size,
    ).toBe(69);
    f.revoke();
    expect((await f.request('history/owners', {})).status).toBe(401);
    expect(
      (
        await f.request('history/retained', {
          owner: { runtimeId: target.runtimeId, incarnation: target.incarnation },
          collection: 'executions',
          after: 0,
        })
      ).status,
    ).toBe(401);
  } finally {
    await f.close();
  }
});
