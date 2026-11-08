import { join } from 'node:path';
import { expect, it } from 'vitest';
import { huddleAgentTemplateFiles, spawnAgentComponent } from '@puddle/shared';
import { spawnDispatcherFixture } from '../../../helpers/huddle/spawn-dispatch.js';
import { readRuntimeJson } from '../../../../src/runtime/ownership/storage.js';
import type { HuddleDefinitionSnapshot } from '../../../../src/huddle/definitions/capture.js';

function template(snapshot: HuddleDefinitionSnapshot, prompt = 'Implement {{input}}') {
  snapshot.components.worker = spawnAgentComponent;
  for (const [name, source] of Object.entries(huddleAgentTemplateFiles('spawn-agent').files))
    snapshot.files[`nodes/example/${name}`] = source;
  Object.assign(snapshot.definition.nodes.find((node) => node.id === 'worker')!.parameters, {
    prompt: { kind: 'literal', value: prompt },
    mode: { kind: 'literal', value: 'headless' },
    title: { kind: 'literal', value: 'Template agent' },
  });
}

it('executes the published Spawn template, returns its reply and handle, then cleans up on Stop', async () => {
  const f = await spawnDispatcherFixture(template);
  try {
    await f.run();
    await expect.poll(() => f.outcome(), { timeout: 15000 }).toEqual(['completed']);
    const operation = await f.spawnRecord();
    if (!operation?.result || !('agent' in operation.result)) throw new Error('No spawned agent');
    const agent = operation.result.agent;
    expect(operation.request).toMatchObject({ mode: 'headless', title: 'Template agent' });
    expect(readRuntimeJson(join(f.home, `${agent.sessionId}.turns.json`))).toMatchObject({
      count: 1,
      prompt: 'Implement spawn fixture',
    });
    const invocations = await f.huddle.request({
      t: 'records',
      collection: 'invocations',
      after: 0,
    });
    if (invocations.t !== 'records') throw new Error('No invocations');
    expect(invocations.rows.map((row) => JSON.parse(row.body))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          node: 'worker',
          result: {
            completed: 'reply:1:Implement spawn fixture',
            agent: { runtime_id: agent.runtimeId, session_id: agent.sessionId },
          },
        }),
      ]),
    );
    expect(f.supervisorRun).toHaveBeenCalledOnce();
    await f.controls.huddles.stop(f.scope.owner.session_id, () => true);
    expect(f.runtimes.get(agent.runtimeId)?.state).toBe('exited');
  } finally {
    await f.close();
  }
});

it.each([
  { prompt: '{{input.missing}}', value: 'spawn fixture' },
  { prompt: '{{input}}', value: '' },
])(
  'rejects an invalid expanded prompt before creating an agent: $prompt, $value',
  async ({ prompt, value }) => {
    const f = await spawnDispatcherFixture((snapshot) => template(snapshot, prompt));
    try {
      await f.admit(value);
      await expect.poll(() => f.outcome(), { timeout: 15000 }).toEqual(['failed']);
      expect(await f.spawnRecord()).toBeUndefined();
      expect(f.supervisorRun).not.toHaveBeenCalled();
      expect(f.db.prepare('SELECT count(*) AS n FROM huddle_runtime_spawns').get()).toEqual({
        n: 0,
      });
    } finally {
      await f.close();
    }
  },
);
