import {
  encodeHuddleAgentTarget,
  huddleComponentSchema,
  type HuddleAgentTarget,
} from '@puddle/shared';
import { schedulerSnapshot } from './scheduler.js';
import { huddleRevisionDigest } from '../../../src/huddle/definitions/revision.js';

export function agentGraphSnapshot(id: string, target: HuddleAgentTarget) {
  const snapshot = schedulerSnapshot(
    id,
    `import { HuddleNode } from 'puddlang/huddle';
export default HuddleNode({contract:'./node.json', async run({inputs, bindings, puddlang}) {
  const agent = await puddlang.attach(bindings.agent);
  return {completed: await agent.ask(String(inputs.value))};
}});`,
  );
  const component = huddleComponentSchema.parse({
    ...snapshot.components.worker,
    capabilities: ['sessions'],
    parameters: {
      worktree: { schema: { type: 'string' }, editor: 'worktree' },
      agent: { schema: { type: 'string' }, editor: 'session' },
    },
  });
  snapshot.components.worker = component;
  snapshot.definition.nodes.find((node) => node.id === 'worker')!.parameters = {
    worktree: { kind: 'literal', value: target.worktree },
    agent: { kind: 'literal', value: target.sessionId },
  };
  snapshot.files['nodes/example/node.json'] = JSON.stringify(component);
  snapshot.files['huddle.json'] = JSON.stringify(snapshot.definition);
  snapshot.digest = huddleRevisionDigest(snapshot.files, snapshot.components);
  return {
    snapshot,
    bindings: { worker: { worktree: target.worktree, agent: encodeHuddleAgentTarget(target) } },
  };
}
