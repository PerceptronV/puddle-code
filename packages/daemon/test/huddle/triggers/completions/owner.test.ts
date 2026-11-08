import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  completionOwnerFixture,
  untilCompletionOwner,
} from '../../../helpers/huddle/completion-owner.js';
import { controllers } from '../../../helpers/runtime-fixture.js';
import { acquireRuntimeControllerWhenAvailable } from '../../../../src/runtime/ownership/storage.js';

it('routes completion pages through the independent owner and retains cursors through controller replacement', async () => {
  const f = await completionOwnerFixture(),
    client = f.client;
  expect(await f.sources()).toEqual([]);
  const arm = { t: 'arm' as const, expectedGeneration: 1, autoStart: false };
  await expect(client.request(arm)).rejects.toThrow('rejected');
  expect(await client.request({ t: 'inspect' })).toMatchObject({
    state: { failure: null, control: { state: 'stopped', generation: 1 } },
  });
  await expect(
    client.request({
      ...arm,
      completionBaselines: [
        { ...f.baseline, target: { ...f.baseline.target, sessionId: randomUUID() } },
      ],
    }),
  ).rejects.toThrow('rejected');
  await client.request({ ...arm, completionBaselines: [f.baseline] });
  const source = (await f.sources())[0]!;
  const page = {
    state: 'events' as const,
    cursor: { ...f.baseline.cursor, sequence: 12 },
    head: 12,
    persistencePending: false,
    records: [f.record(11, { origin: { kind: 'automation', turn: 1 } }), f.record(12)],
  };
  expect(await client.request({ t: 'completion-events', source, page })).toMatchObject({
    t: 'accepted',
  });
  client.close();
  f.controller.release();
  const controller = await acquireRuntimeControllerWhenAvailable(f.home);
  controllers.push(controller);
  const observer = await f.connect(controller.record);
  expect((await f.sources(observer))[0]!.cursor.sequence).toBe(12);
  await expect(observer.request({ t: 'completion-events', source, page })).rejects.toThrow(
    'rejected',
  );
  expect(await observer.request({ t: 'inspect' })).toMatchObject({ state: { failure: null } });
  await untilCompletionOwner(async () => {
    const result = await observer.request({ t: 'records', collection: 'executions', after: 0 });
    if (result.t === 'records') {
      const failed = result.rows.find((row) =>
        ['failed', 'interrupted', 'cancelled'].includes(JSON.parse(row.body).state),
      );
      if (failed) throw new Error(failed.body);
    }
    return (
      result.t === 'records' &&
      result.rows.length === 1 &&
      JSON.parse(result.rows[0]!.body).state === 'completed'
    );
  });
  await observer.request({ t: 'shutdown' });
  await untilCompletionOwner(() => f.child.exitCode !== null);
  expect(f.child.exitCode).toBe(0);
});

it('validates armed Apply before mutation, replaces baselines on Resume and rejects stale failure reports', async () => {
  const f = await completionOwnerFixture(),
    client = f.client;
  await client.request({
    t: 'arm',
    expectedGeneration: 1,
    autoStart: false,
    completionBaselines: [f.baseline],
  });
  const old = (await f.sources())[0]!;
  const apply = {
    t: 'apply' as const,
    expectedGeneration: 2,
    activation: { ...f.launch.initial, id: randomUUID() },
  };
  await expect(client.request(apply)).rejects.toThrow('rejected');
  await expect(
    client.request({
      ...apply,
      completionBaselines: [
        { ...f.baseline, target: { ...f.baseline.target, sessionId: randomUUID() } },
      ],
    }),
  ).rejects.toThrow('rejected');
  expect(await f.sources()).toEqual([old]);
  expect(await client.request({ t: 'inspect' })).toMatchObject({
    state: {
      failure: null,
      control: { generation: 2, activationId: f.launch.initial.id, state: 'armed' },
    },
  });
  await client.request({
    ...apply,
    completionBaselines: [{ ...f.baseline, cursor: { ...f.baseline.cursor, sequence: 30 } }],
  });
  expect((await f.sources())[0]!.cursor.sequence).toBe(30);
  await client.request({ t: 'interrupt' });
  expect(await f.sources()).toEqual([]);
  await client.request({
    t: 'arm',
    expectedGeneration: 4,
    autoStart: false,
    completionBaselines: [{ ...f.baseline, cursor: { ...f.baseline.cursor, sequence: 50 } }],
  });
  await expect(
    client.request({ t: 'completion-unavailable', source: old, error: 'old source disappeared' }),
  ).rejects.toThrow('rejected');
  expect(await client.request({ t: 'inspect' })).toMatchObject({ state: { failure: null } });
  const source = (await f.sources())[0]!;
  expect(source.cursor.sequence).toBe(50);
  await expect(
    client.request({
      t: 'completion-events',
      source,
      page: {
        state: 'gap',
        reason: 'retention',
        cursor: { ...source.cursor, sequence: 100 },
        floor: 90,
        persistencePending: false,
      },
    }),
  ).rejects.toThrow('rejected');
  expect(await client.request({ t: 'inspect' })).toMatchObject({
    state: { failure: expect.stringContaining('observation gap (retention)') },
  });
  expect(await f.sources()).toEqual([]);
  await client.request({ t: 'shutdown' });
});

it('keeps older owners usable while rejecting unsupported completion controls', async () => {
  const f = await completionOwnerFixture(false),
    client = f.client;
  await expect(client.request({ t: 'completion-sources' })).rejects.toThrow('rejected');
  await expect(
    client.request({ t: 'arm', expectedGeneration: 1, autoStart: false, completionBaselines: [] }),
  ).rejects.toThrow('rejected');
  await client.request({ t: 'arm', expectedGeneration: 1, autoStart: false });
  expect(
    await client.request({ t: 'run', node: 'run', eventId: 'manual', data: 'still supported' }),
  ).toMatchObject({ t: 'run' });
  expect(await client.request({ t: 'inspect' })).toMatchObject({ state: { failure: null } });
  await client.request({ t: 'shutdown' });
});
