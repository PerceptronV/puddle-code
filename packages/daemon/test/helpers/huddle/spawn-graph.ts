import { huddleComponentSchema, type HuddleSpawnRequest } from '@puddle/shared';
import { schedulerSnapshot } from './scheduler.js';
import { huddleRevisionDigest } from '../../../src/huddle/definitions/revision.js';

export function spawnGraphSnapshot(
  huddleId: string,
  request: Pick<HuddleSpawnRequest, 'projectId' | 'worktree' | 'accountId' | 'agent'>,
) {
  const snapshot = schedulerSnapshot(
    huddleId,
    `import { HuddleNode } from 'puddlang/huddle';
export default HuddleNode({contract:'./node.json', async run({bindings, puddlang}) {
  const agent = await puddlang.spawn({account:bindings.account, agent:bindings.provider,
    project:bindings.project, worktree:bindings.worktree, mode:'headless', title:'Spawn fixture'});
  return {completed: await agent.ask('Review the graph')};
}});`,
  );
  snapshot.components.worker = huddleComponentSchema.parse({
    ...snapshot.components.worker,
    capabilities: ['sessions'],
    parameters: Object.fromEntries(
      ['worktree', 'account', 'project', 'provider'].map((name) => [
        name,
        { schema: { type: 'string' }, editor: name === 'provider' ? 'agent' : name },
      ]),
    ),
  });
  const bindings = {
    worktree: request.worktree,
    account: String(request.accountId),
    provider: request.agent,
    project: request.projectId,
  };
  snapshot.definition.nodes.find((node) => node.id === 'worker')!.parameters = Object.fromEntries(
    Object.entries(bindings).map(([key, value]) => [key, { kind: 'literal', value }]),
  );
  snapshot.definition.execution.maxAgents = 2;
  snapshot.definition.execution.concurrency = 2;
  snapshot.definition.nodes.find((node) => node.id === 'worker')!.concurrency = 2;
  snapshot.files['nodes/example/node.json'] = JSON.stringify(snapshot.components.worker);
  snapshot.files['huddle.json'] = JSON.stringify(snapshot.definition);
  snapshot.digest = huddleRevisionDigest(snapshot.files, snapshot.components);
  return { snapshot, bindings: { worker: bindings } };
}
