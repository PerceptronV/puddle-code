import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  huddleAgentTemplateFiles,
  huddleDefinitionSchema,
  type HuddleInstallTemplate,
} from '@puddle/shared';
import { spawnDispatcherFixture } from '../../../helpers/huddle/spawn-dispatch.js';
import { readRuntimeJson } from '../../../../src/runtime/ownership/storage.js';

it('spawns two agents once and reuses their exact handles through shipped prompt/review feedback nodes', async () => {
  const f = await spawnDispatcherFixture((snapshot, bindings) => {
    const original = snapshot.definition.nodes.find((node) => node.id === 'worker')!;
    const add = (id: string, template: HuddleInstallTemplate['template'], spawn = false) => {
      const asset = huddleAgentTemplateFiles(template);
      const directory = id === 'worker' ? 'example' : id;
      snapshot.components[id] = asset.component;
      for (const [name, content] of Object.entries(asset.files))
        snapshot.files[`nodes/${directory}/${name}`] = content;
      bindings[id] = spawn ? { ...bindings.worker } : { worktree: bindings.worker!.worktree! };
      return {
        id,
        source: { kind: 'local', manifest: `nodes/${directory}/node.json` },
        parameters: spawn
          ? {
              ...original.parameters,
              mode: { kind: 'literal', value: 'headless' },
              prompt: { kind: 'literal', value: '{{input}}' },
            }
          : {
              worktree: original.parameters.worktree,
              prompt: { kind: 'literal', value: '{{input}}' },
            },
      };
    };
    const edge = (id: string, source: string, port: string, target: string, input = 'value') => ({
      id,
      from: { node: source, port },
      to: { node: target, port: input },
    });
    snapshot.definition = huddleDefinitionSchema.parse({
      ...snapshot.definition,
      execution: { ...snapshot.definition.execution, maxAgents: 2, maxTurns: 6 },
      nodes: [
        snapshot.definition.nodes[0],
        add('worker', 'spawn-agent', true),
        add('spawn-reviewer', 'spawn-agent', true),
        add('coder', 'prompt-spawned-agent'),
        add('reviewer', 'review-spawned-agent'),
        snapshot.definition.nodes[2],
      ],
      edges: [
        edge('spawn-coder', 'run', 'event', 'worker'),
        edge('spawn-reviewer', 'worker', 'completed', 'spawn-reviewer'),
        edge('coder-handle', 'worker', 'agent', 'coder', 'agent'),
        edge('reviewer-handle', 'spawn-reviewer', 'agent', 'reviewer', 'agent'),
        edge('seed', 'spawn-reviewer', 'completed', 'coder'),
        edge('review', 'coder', 'completed', 'reviewer'),
        {
          ...edge('feedback', 'reviewer', 'completed', 'coder'),
          feedback: { maxRounds: 3, while: { path: ['complete'], equals: false } },
        },
        edge('result', 'reviewer', 'completed', 'result'),
      ],
    });
  });
  try {
    writeFileSync(join(f.home, 'test-review-output'), '');
    await f.admit();
    await expect.poll(() => f.outcome(), { timeout: 25000 }).toEqual(['completed']);
    const page = await f.huddle.request({ t: 'spawn-page', after: 0 });
    if (page.t !== 'spawn-page') throw new Error('No spawn records');
    expect(page.page.records).toHaveLength(2);
    expect(f.supervisorRun).toHaveBeenCalledTimes(2);
    const agents = page.page.records.map(({ operation }) => {
      if (!operation.result || !('agent' in operation.result)) throw new Error('No agent');
      return operation.result.agent;
    });
    const records = await f.huddle.request({ t: 'records', collection: 'invocations', after: 0 });
    if (records.t !== 'records') throw new Error('No invocation records');
    const nodes = records.rows.map((row) => JSON.parse(row.body));
    for (const [i, name] of ['coder', 'reviewer'].entries()) {
      const attempts = nodes.filter((node) => node.node === name);
      expect(attempts.map((node) => node.iteration)).toEqual([0, 1]);
      expect(attempts.map((node) => node.inputs.agent)).toEqual(
        Array(2).fill({ runtime_id: agents[i]!.runtimeId, session_id: agents[i]!.sessionId }),
      );
      expect(readRuntimeJson(join(f.home, `${agents[i]!.sessionId}.turns.json`))).toMatchObject({
        count: 3,
      });
    }
    expect(nodes.filter((node) => node.node === 'coder')[1].inputs.value).toEqual(
      nodes.find((node) => node.node === 'reviewer').result.completed,
    );
    expect(nodes.filter((node) => node.node === 'reviewer')[1].result.completed.complete).toBe(
      true,
    );
    await expect
      .poll(() => f.db.prepare('SELECT COUNT(*) AS n FROM runtime_turns WHERE consumed = 1').get())
      .toEqual({ n: 6 });
    await f.controls.huddles.stop(f.scope.owner.session_id, () => true);
    for (const agent of agents) expect(f.runtimes.get(agent.runtimeId)?.state).toBe('exited');
  } finally {
    await f.close();
  }
});
