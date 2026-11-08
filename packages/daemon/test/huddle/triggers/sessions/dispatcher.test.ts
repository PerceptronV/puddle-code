import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { sessionDispatchFixture } from '../../../helpers/huddle/session-dispatch.js';
import { until } from '../../../helpers/huddle/controller.js';
import { RuntimeConnectionLost } from '../../../../src/runtime/transport/client.js';

it('gates the selected runtime before launch and observes an archived terminal without an agent bridge', async () => {
  const f = await sessionDispatchFixture(true);
  try {
    const metadataPath = join(f.installed.release, 'RUNTIME_CAPABILITIES.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    delete metadata.roles.huddle.sessionEvents;
    writeFileSync(metadataPath, JSON.stringify(metadata));
    const document = await f.source();
    const refused = await f.request('start', { expected_digest: document.digest, variables: {} });
    expect(refused.body.error.code).toBe('huddle_execution_unsupported');
    expect(f.run).not.toHaveBeenCalled();
    metadata.roles.huddle.sessionEvents = 1;
    writeFileSync(metadataPath, JSON.stringify(metadata));
    const started = await f.request('start', { expected_digest: document.digest, variables: {} });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const target = started.body.owner.target;
    f.startDispatcher();
    f.sessions.setStatus(f.watched.id, 'running');
    const history = {
      owner: { runtimeId: target.runtimeId, incarnation: target.incarnation },
      collection: 'executions',
      after: 0,
    };
    await until(
      async () =>
        (await f.request('history', history)).body.records?.[0]?.record.state === 'completed',
    );
    const execution = (await f.request('history', history)).body.records[0].record;
    const invocations = await f.request('history', {
      ...history,
      collection: 'invocations',
      parent: execution.id,
    });
    expect(
      invocations.body.records.some(
        (row: { record: { result?: { completed?: { sessionId: string } } } }) =>
          row.record.result?.completed?.sessionId === f.watched.id,
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

it('catches up after dispatcher replacement and a lost reply, and excludes paused observations on Resume', async () => {
  const f = await sessionDispatchFixture();
  try {
    const started = await f.request('start', {
      expected_digest: (await f.source()).digest,
      variables: {},
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    let target = started.body.owner.target;
    const client = f.connections.getHuddle(target.runtimeId)!;
    const history = {
      owner: { runtimeId: target.runtimeId, incarnation: target.incarnation },
      collection: 'executions',
      after: 0,
    };
    const count = async () =>
      (await f.request('history', history)).body.records?.filter(
        (row: { record: { state: string } }) => row.record.state === 'completed',
      ).length;
    const original = client.request.bind(client);
    let lost = false;
    vi.spyOn(client, 'request').mockImplementation(async (request) => {
      const response = await original(request);
      if (request.t === 'session-events' && !lost) {
        lost = true;
        throw new RuntimeConnectionLost('Fixture lost delivery acknowledgement');
      }
      return response;
    });
    let dispatcher = f.startDispatcher();
    f.sessions.setStatus(f.watched.id, 'running');
    await until(async () => (await count()) === 1);
    expect(lost).toBe(true);
    await f.stopDispatcher();
    f.sessions.setStatus(f.watched.id, 'exited');
    f.sessions.setStatus(f.watched.id, 'running');
    dispatcher = f.startDispatcher();
    await until(async () => (await count()) === 2);
    const held = dispatcher.pause();
    await held.drain();
    f.sessions.setStatus(f.watched.id, 'exited');
    f.sessions.setStatus(f.watched.id, 'running');
    expect(await count()).toBe(2);
    held.release();
    await until(async () => (await count()) === 3);
    await f.stopDispatcher();
    const before = await client.request({ t: 'session-sources' });
    if (before.t !== 'session-sources') throw new Error('Missing source response');
    const stale = before.sources[0]!;
    const interrupted = await f.request('interrupt', { target });
    expect(interrupted.status).toBe(200);
    f.sessions.setStatus(f.watched.id, 'exited');
    f.sessions.setStatus(f.watched.id, 'running');
    const resumeBaseline = f.feed.checkpoint();
    const resumed = await f.request('rearm', { target: interrupted.body.owner.target });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    target = resumed.body.owner.target;
    await expect(
      client.request({
        t: 'session-events',
        source: stale,
        page: f.feed.read(stale.scope, stale.cursor),
      }),
    ).rejects.toThrow('rejected');
    const current = await client.request({ t: 'session-sources' });
    if (current.t !== 'session-sources') throw new Error('Missing source response');
    expect(current.sources[0]!.cursor).toEqual(resumeBaseline);
    expect((await f.request('runtime')).body.owner.lifecycle).toBe('armed');
    f.startDispatcher();
    f.sessions.setStatus(f.watched.id, 'exited');
    f.sessions.setStatus(f.watched.id, 'running');
    await until(async () => (await count()) === 4);
    expect((await f.request('stop', { target })).status).toBe(200);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it('fails visibly on a retained feed gap instead of rebasing and losing events', async () => {
  const f = await sessionDispatchFixture();
  try {
    const started = await f.request('start', {
      expected_digest: (await f.source()).digest,
      variables: {},
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    f.sessions.setStatus(f.watched.id, 'running');
    // Deleting observed history advances the real feed loss floor.
    f.db.prepare('DELETE FROM huddle_session_feed').run();
    f.startDispatcher();
    const client = f.connections.getHuddle(started.body.owner.target.runtimeId)!;
    await until(async () => {
      const response = await client.request({ t: 'inspect' });
      return response.t === 'state' && !!response.state.failure;
    });
    expect(client.state!.failure).toContain('observation gap (retention)');
    const sources = await client.request({ t: 'session-sources' });
    expect(sources).toMatchObject({ t: 'session-sources', sources: [] });
  } finally {
    await f.close();
  }
});

it('requires a host baseline before arming and switches filters on exact Apply without replaying prior observations', async () => {
  const f = await sessionDispatchFixture(true);
  try {
    const started = await f.request('start', {
      expected_digest: (await f.source()).digest,
      variables: {},
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const target = started.body.owner.target;
    const client = f.connections.getHuddle(target.runtimeId)!;
    const interrupted = await f.request('interrupt', { target });
    expect(interrupted.status).toBe(200);
    const generation = interrupted.body.owner.target.generation;
    await expect(
      client.request({ t: 'arm', expectedGeneration: generation, autoStart: false }),
    ).rejects.toThrow('rejected');
    const inspection = await client.request({ t: 'inspect' });
    expect(inspection).toMatchObject({
      t: 'state',
      state: { failure: null, control: { generation, state: 'interrupted' } },
    });
    const resumed = await f.request('rearm', { target: interrupted.body.owner.target });
    expect(resumed.status).toBe(200);
    const old = await client.request({ t: 'session-sources' });
    if (old.t !== 'session-sources') throw new Error('Missing sources');
    const manifest = join(f.root, 'huddle.json');
    const definition = JSON.parse(readFileSync(manifest, 'utf8'));
    definition.nodes[0].parameters.statuses.value = ['exited'];
    writeFileSync(manifest, JSON.stringify(definition));
    f.sessions.setStatus(f.watched.id, 'running');
    f.sessions.setStatus(f.watched.id, 'exited');
    const baseline = f.feed.checkpoint();
    const applied = await f.request('apply', {
      target: resumed.body.owner.target,
      expected_digest: (await f.source()).digest,
      variables: {},
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    await expect(
      client.request({ t: 'session-unavailable', source: old.sources[0]!, error: 'stale failure' }),
    ).rejects.toThrow('rejected');
    const current = await client.request({ t: 'session-sources' });
    expect(current).toMatchObject({
      t: 'session-sources',
      sources: [
        {
          cursor: baseline,
          statuses: ['exited'],
          activationId: applied.body.owner.target.activationId,
        },
      ],
    });
    const history = {
      owner: { runtimeId: target.runtimeId, incarnation: target.incarnation },
      collection: 'executions',
      after: 0,
    };
    expect((await f.request('history', history)).body.records).toHaveLength(0);
    f.startDispatcher();
    f.sessions.setStatus(f.watched.id, 'running');
    f.sessions.setStatus(f.watched.id, 'exited');
    await until(
      async () =>
        (await f.request('history', history)).body.records?.[0]?.record.state === 'completed',
    );
    expect((await f.request('history', history)).body.records).toHaveLength(1);
  } finally {
    await f.close();
  }
});
