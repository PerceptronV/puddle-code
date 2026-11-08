import { expect, it } from 'vitest';
import { huddleAgentTemplateFiles } from '@puddle/shared';
import { spawnDispatcherFixture } from '../../../helpers/huddle/spawn-dispatch.js';
import { resolveHuddleAgent } from '../../../../src/huddle/execution/agents.js';
import { until } from '../../../helpers/huddle/controller.js';

it.each(['resume'] as const)(
  '%s template completes a prompt through a real owner, worker and existing agent service',
  async (action) => {
    const f = await spawnDispatcherFixture(async (snapshot, bindings, host) => {
      host.sessions.setAgentSessionRef(host.session.id, 'fixture-conversation');
      const template = huddleAgentTemplateFiles(`${action}-agent`);
      snapshot.components.worker = template.component;
      for (const [name, text] of Object.entries(template.files))
        snapshot.files[`nodes/example/${name}`] = text;
      snapshot.definition.nodes.find((node) => node.id === 'worker')!.parameters = {
        worktree: { kind: 'literal', value: host.request.worktree },
        agent: { kind: 'literal', value: host.session.id },
        prompt: { kind: 'literal', value: 'Continue: {{input}}' },
      };
      bindings.worker = {
        worktree: host.request.worktree,
        agent: resolveHuddleAgent(
          { sessions: host.sessions, runtimes: host.runtimes, turns: host.deps.turns },
          host.profile.id,
          host.project.id,
          host.session.id,
          host.request.worktree,
          action,
        ),
      };
    });
    try {
      const before = f.supervisorRun.mock.calls.length;
      await f.admit('review');
      await until(async () =>
        (await f.outcome()).some((state) => state === 'completed' || state === 'failed'),
      );
      const executions = await f.huddle.request({
        t: 'records',
        collection: 'executions',
        after: 0,
      });
      expect(await f.outcome(), JSON.stringify(executions)).toEqual(['completed']);
      const page = await f.huddle.request({ t: 'lifecycle-page', after: 0 });
      expect(page.t).toBe('lifecycle-page');
      if (page.t !== 'lifecycle-page') throw new Error('Missing lifecycle result');
      expect(page.page.records).toHaveLength(1);
      expect(page.page.records[0]!.operation.state).toBe('completed');
      expect(f.supervisorRun.mock.calls.length).toBe(before + 1);
      await f.dispatcher.close();
      f.replace();
      expect(
        (
          await f.huddle.request({
            t: 'lifecycle-claim',
            operationId: page.page.records[0]!.operation.scope.operationId,
          })
        ).t,
      ).toBe('lifecycle-claim');
      expect(f.supervisorRun.mock.calls.length).toBe(before + 1);
      // Interrupting a huddle never takes ownership of a resumed/restarted agent.
      await f.huddle.request({ t: 'interrupt' });
      expect(f.runtimes.ownerOf(f.session.id)?.state).toBe('running');
      await f.controls.stop(f.session.id, () => true);
    } finally {
      await f.close();
    }
  },
);
