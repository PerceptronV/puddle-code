import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  huddleRuntimeInspectionSchema,
  huddleHistoryPageSchema,
} from '@puddle/shared';
import { HuddleClient } from '../../../../cli/src/huddle/client.js';
import { parseHuddleCommand, runHuddleCommand } from '../../../../cli/src/huddle/commands.js';
import { huddleExecutionFixture } from '../../helpers/huddle/execution.js';
import { until } from '../../helpers/huddle/controller.js';

it('uses the CLI client through real authoring/control routes and preserves a lost accepted Run without replay', async () => {
  const f = await huddleExecutionFixture();
  try {
    const requests: Array<{ path: string; body?: unknown }> = [];
    let loseRun = false;
    const client = new HuddleClient(async (path, body) => {
      requests.push({ path, body });
      const response = await f.app.request(`/api/huddle/${f.profile.id}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(result));
      if (loseRun && path.endsWith('/run')) {
        loseRun = false;
        throw new Error('Lost accepted Run reply');
      }
      return result;
    }, PROTOCOL_VERSION);
    const location = { project_id: f.project.id, worktree: f.home };
    const created = await client.create({ ...location, name: 'CLI blank graph' });
    expect(created.created).toBe(true);
    expect(created.session.kind).toBe('huddle');
    expect(created.document.definition.nodes).toEqual([]);
    const opened = await client.open({ ...location, huddle_id: created.session.huddle_id });
    expect(opened.created).toBe(false);
    expect(opened.session.id).toBe(created.session.id);
    expect(f.run).not.toHaveBeenCalled();
    const current = await client.open({ ...location, huddle_id: f.session.huddle_id! });
    expect(current.session.id).toBe(f.session.id);
    const sid = current.session.id;
    const execute = (action: string, request?: unknown) =>
      client.execution.execute(
        // Use the same command parser as the executable, including JSON payload validation.
        (() => {
          const command = parseHuddleCommand(
            [action, sid],
            request === undefined ? {} : { request: JSON.stringify(request) },
          );
          if (command.action !== 'execution') throw new Error('Expected execution command');
          return command.command;
        })(),
      );
    const initial = huddleRuntimeInspectionSchema.parse(await execute('runtime'));
    expect(initial.owner).toBe(null);
    const started = huddleRuntimeInspectionSchema.parse(
      await execute('start', { expected_digest: current.document.digest, variables: {} }),
    );
    if (!started.owner?.connected) throw new Error('Expected live fixture owner');
    const firstTarget = started.owner.target;
    expect(existsSync(join(f.home, 'entered'))).toBe(false);

    const file = join(f.root, 'huddle.json');
    const graph = JSON.parse(readFileSync(file, 'utf8'));
    graph.name = 'Changed saved graph';
    writeFileSync(file, JSON.stringify(graph));
    const saved = await client.inspect({ ...location, huddle_id: f.session.huddle_id! });
    await expect(
      execute('apply', {
        target: firstTarget,
        expected_digest: current.document.digest,
        variables: {},
      }),
    ).rejects.toThrow('huddle_source_changed');
    const applied = huddleRuntimeInspectionSchema.parse(
      await execute('apply', { target: firstTarget, expected_digest: saved.digest, variables: {} }),
    );
    if (!applied.owner?.connected) throw new Error('Expected live fixture owner');
    const target = applied.owner.target;
    expect(target.activationId).not.toBe(firstTarget.activationId);
    await expect(
      execute('run', { target: firstTarget, node: 'run', event_id: randomUUID(), data: f.home }),
    ).rejects.toThrow('huddle_control_changed');
    const event_id = randomUUID();
    loseRun = true;
    const before = requests.length;
    await expect(execute('run', { target, node: 'run', event_id, data: f.home })).rejects.toThrow(
      'Do not retry automatically',
    );
    expect(requests).toHaveLength(before + 1);
    await until(() => existsSync(join(f.home, 'entered')));
    writeFileSync(join(f.home, 'release'), 'go');
    const owner = { runtimeId: target.runtimeId, incarnation: target.incarnation };
    let history = huddleHistoryPageSchema.parse(
      await execute('history', { owner, collection: 'executions', after: 0 }),
    );
    await until(async () => {
      history = huddleHistoryPageSchema.parse(
        await execute('history', { owner, collection: 'executions', after: 0 }),
      );
      return (
        history.collection === 'executions' && history.records[0]?.record.state === 'completed'
      );
    });
    expect(history.records).toHaveLength(1);
    expect(await execute('triggers', { target })).toMatchObject({
      target,
      sources: [{ node: 'run', admitted: 1, queued: 0, running: 0 }],
    });
    if (history.collection !== 'executions') throw new Error('Expected execution history');
    expect(history.records[0]!.record.revision).toBe(saved.digest);
    expect(readFileSync(join(f.home, 'entered'), 'utf8')).toBe('x');
    const interrupted = huddleRuntimeInspectionSchema.parse(await execute('interrupt', { target }));
    expect(interrupted.owner).toMatchObject({ lifecycle: 'interrupted' });
    if (!interrupted.owner?.connected) throw new Error('Expected interrupted owner');
    const resumed = huddleRuntimeInspectionSchema.parse(
      await execute('resume', { target: interrupted.owner.target }),
    );
    expect(resumed.owner).toMatchObject({
      lifecycle: 'armed',
      target: { activationId: target.activationId },
    });
    if (!resumed.owner?.connected) throw new Error('Expected rearmed owner');
    let stopped: unknown;
    await runHuddleCommand(
      client,
      parseHuddleCommand(['stop', sid], {
        request: JSON.stringify({ target: resumed.owner.target }),
      }),
      (value) => {
        stopped = value;
      },
    );
    expect(stopped).toEqual({ stopped: true });
    expect(await execute('runtime')).toMatchObject({ owner: null, unresolved: false });
    expect(f.run).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});
