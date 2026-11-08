import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { huddleRuntimeInspectionSchema, huddleHistoryPageSchema } from '@puddle/shared';
import { huddleExecutionFixture as fixture } from '../../helpers/huddle/execution.js';
import { withInterval } from '../../helpers/huddle/interval.js';
import { until } from '../../helpers/huddle/controller.js';
import { runtimeRelease } from '../../helpers/runtime-release.js';
import { RuntimeConnectionLost } from '../../../src/runtime/transport/client.js';

it('starts saved source without running it, runs exact input, applies a revision, and exposes bounded public results', async () => {
  const f = await fixture();
  try {
    expect((await f.request('runtime')).body).toEqual({
      session_id: f.session.id,
      owner: null,
      unresolved: false,
    });
    let document = await f.source();
    const started = await f.request('start', { expected_digest: document.digest, variables: {} });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    huddleRuntimeInspectionSchema.parse(started.body);
    const initial = started.body.owner.target;
    expect(started.body.owner).toMatchObject({
      connected: true,
      lifecycle: 'armed',
      executing: false,
    });
    expect(existsSync(join(f.home, 'entered'))).toBe(false);
    expect(
      (await f.request('start', { expected_digest: document.digest, variables: {} })).body.error
        .code,
    ).toBe('huddle_owned');
    const request = { target: initial, node: 'run', event_id: randomUUID(), data: f.home };
    expect((await f.request('run', { ...request, node: 'not-a-trigger' })).body.error.code).toBe(
      'huddle_command_rejected',
    );
    const accepted = await f.request('run', request);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await f.request('run', request)).body).toEqual({ ...accepted.body, duplicate: true });
    await until(() => existsSync(join(f.home, 'entered')));
    writeFileSync(join(f.home, 'release'), 'go');
    const history = {
      owner: { runtimeId: initial.runtimeId, incarnation: initial.incarnation },
      collection: 'executions',
      after: 0,
    };
    await until(
      async () =>
        (await f.request('history', history)).body.records?.[0]?.record.state === 'completed',
    );
    const page = (await f.request('history', history)).body;
    huddleHistoryPageSchema.parse(page);
    expect(page.records[0].record).toMatchObject({
      id: accepted.body.executionId,
      revision: document.digest,
      activationId: initial.activationId,
    });
    expect(page.records[0].record).not.toHaveProperty('eventKey');
    expect(page.records[0].record).not.toHaveProperty('limits');
    const nodes = (
      await f.request('history', {
        ...history,
        collection: 'invocations',
        parent: accepted.body.executionId,
      })
    ).body;
    huddleHistoryPageSchema.parse(nodes);
    expect(
      nodes.records.some(
        (row: { record: { result?: unknown } }) =>
          JSON.stringify(row.record.result) === '{"completed":42}',
      ),
    ).toBe(true);
    expect(readFileSync(join(f.home, 'entered'), 'utf8')).toBe('x');
    const script = join(f.root, 'nodes/example/run.ts');
    writeFileSync(script, readFileSync(script, 'utf8').replace('completed: 42', 'completed: 84'));
    document = await f.source();
    const applied = await f.request('apply', {
      target: initial,
      expected_digest: document.digest,
      variables: {},
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const next = applied.body.owner.target;
    expect(next.activationId).not.toBe(initial.activationId);
    expect((await f.request('run', { ...request, event_id: randomUUID() })).body.error.code).toBe(
      'huddle_control_changed',
    );
    const second = await f.request('run', { ...request, target: next, event_id: randomUUID() });
    expect(second.status).toBe(200);
    await until(async () =>
      (
        await f.request('history', {
          ...history,
          collection: 'invocations',
          parent: second.body.executionId,
        })
      ).body.records?.some(
        (row: { record: { result?: { completed?: number } } }) =>
          row.record.result?.completed === 84,
      ),
    );
    const interrupted = await f.request('interrupt', { target: next });
    expect(interrupted.status).toBe(200);
    expect(interrupted.body.owner.lifecycle).toBe('interrupted');
    const resumed = await f.request('rearm', { target: interrupted.body.owner.target });
    expect(resumed.status).toBe(200);
    expect(resumed.body.owner.target.activationId).toBe(next.activationId);
    expect((await f.request('stop', { target: resumed.body.owner.target })).body).toEqual({
      stopped: true,
    });
    expect((await f.request('runtime')).body).toMatchObject({ owner: null, unresolved: false });
    expect(f.run).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it('rejects remote, wrong-profile, stale-source and unsupported-runtime admission without launch', async () => {
  const f = await fixture();
  try {
    const document = await f.source();
    const body = { expected_digest: document.digest, variables: {} };
    expect(
      (await f.request('start', { ...body, expected_digest: '0'.repeat(64) })).body.error.code,
    ).toBe('huddle_source_changed');
    expect(
      (await f.request('start', { ...body, variables: { unknown: true } })).body.error.code,
    ).toBe('huddle_activation_invalid');
    const other = f.profiles.create({ name: 'Other', branch_prefix: '' });
    expect((await f.request('runtime', undefined, other.id)).status).toBe(403);
    expect((await f.request('start', body, other.id)).status).toBe(403);
    f.sessions.setStatus(f.session.id, 'archived');
    expect((await f.request('start', body)).body.error.code).toBe('huddle_archived');
    f.sessions.setStatus(f.session.id, 'exited');
    runtimeRelease(f.home, '1.0.0').select();
    expect((await f.request('start', body)).body.error.code).toBe('huddle_runtime_unavailable');
    f.installed.select();
    f.remote();
    for (const action of ['start', 'apply', 'rearm', 'run', 'interrupt', 'stop', 'history'])
      expect((await f.request(action, body)).status).toBe(403);
    expect((await f.request('runtime')).status).toBe(403);
    expect(f.run).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it('rejects expired authority after asynchronous source admission and malformed route/body input', async () => {
  const f = await fixture();
  try {
    const document = await f.source();
    expect(
      (
        await f.request('start', {
          expected_digest: document.digest,
          variables: {},
          surprise: true,
        })
      ).status,
    ).toBe(400);
    expect((await f.request('runtime', undefined, undefined, 'not-a-session')).status).toBe(400);
    expect(
      (
        await f.request('history', {
          owner: { runtimeId: randomUUID(), incarnation: randomUUID() },
          collection: 'invocations',
          after: 0,
        })
      ).status,
    ).toBe(400);
    f.storage.assertAdmission.mockImplementationOnce(async () => {
      f.revoke();
    });
    expect(
      (await f.request('start', { expected_digest: document.digest, variables: {} })).status,
    ).toBe(401);
    expect(f.run).not.toHaveBeenCalled();
    expect((await f.request('runtime')).status).toBe(401);
  } finally {
    await f.close();
  }
});

it('observes a lost Run reply, uses an older default without replacing its owner, and stops after source removal', async () => {
  const f = await fixture();
  try {
    const document = await f.source();
    const started = await f.request('start', { expected_digest: document.digest, variables: {} });
    expect(started.status).toBe(200);
    const target = started.body.owner.target;
    runtimeRelease(f.home, '1.0.0').select();
    const client = f.connections.getHuddle(target.runtimeId)!;
    const request = client.request.bind(client);
    const calls = vi.spyOn(client, 'request').mockImplementation(async (command) => {
      const response = await request(command);
      if (command.t === 'run') throw new RuntimeConnectionLost();
      return response;
    });
    expect(
      (await f.request('run', { target, node: 'run', event_id: randomUUID(), data: f.home })).body
        .error.code,
    ).toBe('huddle_outcome_unknown');
    expect(
      (
        await f.request('history', {
          owner: { runtimeId: target.runtimeId, incarnation: target.incarnation },
          collection: 'executions',
          after: 0,
        })
      ).body.records,
    ).toHaveLength(1);
    expect(calls.mock.calls.filter(([command]) => command.t === 'run')).toHaveLength(1);
    rmSync(f.root, { recursive: true });
    expect((await f.request('runtime')).body.owner.target).toEqual(target);
    expect((await f.request('rearm', { target })).body.error.code).toBe(
      'huddle_source_unavailable',
    );
    expect(
      (await f.request('run', { target, node: 'run', event_id: randomUUID(), data: null })).body
        .error.code,
    ).toBe('huddle_source_unavailable');
    expect((await f.request('stop', { target })).body).toEqual({ stopped: true });
    expect(f.run).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it('serialises concurrent Starts, observes lost arming, and preserves host identity across a later explicit Start', async () => {
  const f = await fixture();
  try {
    const document = await f.source();
    const input = { expected_digest: document.digest, variables: {} };
    const launch = f.launcher.launchHuddle.bind(f.launcher);
    vi.spyOn(f.launcher, 'launchHuddle').mockImplementationOnce(async (...args) => {
      await launch(...args);
      const owner = f.runtimes.ownerOf(f.session.id)!;
      const client = f.connections.getHuddle(owner.runtime_id)!;
      const request = client.request.bind(client);
      vi.spyOn(client, 'request').mockImplementation(async (command) => {
        const response = await request(command);
        if (command.t === 'arm') throw new RuntimeConnectionLost();
        return response;
      });
    });
    const replies = await Promise.all([f.request('start', input), f.request('start', input)]);
    expect(replies.map((reply) => reply.body.error.code).sort()).toEqual([
      'huddle_outcome_unknown',
      'huddle_owned',
    ]);
    expect(f.run).toHaveBeenCalledTimes(1);
    const observed = (await f.request('runtime')).body;
    expect(observed.owner.lifecycle).toBe('armed');
    const target = observed.owner.target;
    const host = readFileSync(join(f.home, 'huddle-host.json'), 'utf8');
    expect((await f.request('stop', { target })).status).toBe(200);
    const next = await f.request('start', input);
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(next.body.owner.target.runtimeId).not.toBe(target.runtimeId);
    expect(readFileSync(join(f.home, 'huddle-host.json'), 'utf8')).toBe(host);
    expect(
      (await f.request('run', { target, node: 'run', event_id: randomUUID(), data: f.home })).body
        .error.code,
    ).toBe('huddle_unavailable');
    expect((await f.request('stop', { target: next.body.owner.target })).status).toBe(200);
  } finally {
    await f.close();
  }
});

it('refuses unavailable bridges and rechecks declared worktrees after storage admission', async () => {
  const f = await fixture();
  try {
    const alias = join(f.home, 'node-worktree');
    symlinkSync(f.home, alias);
    const componentPath = join(f.root, 'nodes/example/node.json');
    const component = JSON.parse(readFileSync(componentPath, 'utf8'));
    component.capabilities = ['sessions'];
    component.parameters = { worktree: { schema: { type: 'string' }, editor: 'worktree' } };
    writeFileSync(componentPath, JSON.stringify(component));
    const manifest = join(f.root, 'huddle.json');
    const definition = JSON.parse(readFileSync(manifest, 'utf8'));
    definition.nodes.find((node: { id: string }) => node.id === 'worker').parameters = {
      worktree: { kind: 'literal', value: alias },
    };
    writeFileSync(manifest, JSON.stringify(definition));
    let document = await f.source();
    expect(
      (await f.request('start', { expected_digest: document.digest, variables: {} })).body.error
        .code,
    ).toBe('huddle_execution_unsupported');
    component.capabilities = ['files'];
    writeFileSync(componentPath, JSON.stringify(component));
    document = await f.source();
    f.storage.assertAdmission.mockImplementationOnce(async () => {
      const unregistered = join(f.home, 'unregistered');
      mkdirSync(unregistered);
      rmSync(alias);
      symlinkSync(unregistered, alias);
    });
    expect(
      (await f.request('start', { expected_digest: document.digest, variables: {} })).body.error
        .code,
    ).toBe('unknown_worktree');
    expect(f.run).not.toHaveBeenCalled();
    expect(f.runtimes.hasUnreleasedHuddle(f.session.id)).toBe(false);
  } finally {
    await f.close();
  }
});

it('gates interval launch on the selected runtime and replaces automatic schedules on Apply', async () => {
  const f = await fixture();
  try {
    const snapshot = withInterval(f.options.snapshot);
    writeFileSync(join(f.root, 'huddle.json'), snapshot.files['huddle.json']!);
    writeFileSync(
      join(f.root, 'nodes/example/run.ts'),
      "import {HuddleNode} from 'puddlang/huddle'; export default HuddleNode({contract:'./node.json', async run({inputs}) { return {completed: inputs.value}; }});",
    );
    const metadataPath = join(f.installed.release, 'RUNTIME_CAPABILITIES.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    delete metadata.roles.huddle.timers;
    writeFileSync(metadataPath, JSON.stringify(metadata));
    let document = await f.source();
    const refused = await f.request('start', { expected_digest: document.digest, variables: {} });
    expect(refused.body.error.code).toBe('huddle_execution_unsupported');
    expect(f.run).not.toHaveBeenCalled();
    expect(f.runtimes.hasUnreleasedHuddle(f.session.id)).toBe(false);
    metadata.roles.huddle.timers = 1;
    writeFileSync(metadataPath, JSON.stringify(metadata));
    const started = await f.request('start', { expected_digest: document.digest, variables: {} });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const target = started.body.owner.target;
    const history = {
      owner: { runtimeId: target.runtimeId, incarnation: target.incarnation },
      collection: 'executions',
      after: 0,
    };
    await until(async () =>
      (await f.request('history', history)).body.records?.some(
        (row: { record: { state: string } }) => row.record.state === 'completed',
      ),
    );
    const definition = JSON.parse(readFileSync(join(f.root, 'huddle.json'), 'utf8'));
    definition.nodes[0].parameters.intervalMs.value = 60000;
    writeFileSync(join(f.root, 'huddle.json'), JSON.stringify(definition));
    document = await f.source();
    const applied = await f.request('apply', {
      target,
      expected_digest: document.digest,
      variables: {},
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const before = (await f.request('history', history)).body.records.length;
    await new Promise((resolve) => setTimeout(resolve, 1250));
    expect((await f.request('history', history)).body.records).toHaveLength(before);
    expect((await f.request('stop', { target: applied.body.owner.target })).status).toBe(200);
  } finally {
    await f.close();
  }
});
