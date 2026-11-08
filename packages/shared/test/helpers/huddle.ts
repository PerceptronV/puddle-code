import { huddleComponentSchema } from '../../src/api/huddle/components.js';
import { huddleDefinitionSchema } from '../../src/api/huddle/definitions.js';

export const huddleFixtureId = '50dbbe542e6d45da98cda2baaa212a65';
export const manualComponent = huddleComponentSchema.parse({
  format: 1,
  id: 'puddle.trigger.manual',
  version: 1,
  category: 'trigger',
  title: 'Run',
  outputs: { event: { schema: {}, emission: 'event' } },
});
export const resultComponent = huddleComponentSchema.parse({
  format: 1,
  id: 'puddle.readout.result',
  version: 1,
  category: 'readout',
  title: 'Result',
  inputs: { value: { schema: {} } },
});
export const fixtureBuiltins = new Map(
  [manualComponent, resultComponent].map((component) => [
    `${component.id}@${component.version}`,
    component,
  ]),
);

export function manualHuddleFixture() {
  return huddleDefinitionSchema.parse({
    format: 1,
    id: huddleFixtureId,
    name: 'Manual result',
    nodes: [
      { id: 'run', source: { kind: 'builtin', component: manualComponent.id, version: 1 } },
      { id: 'result', source: { kind: 'builtin', component: resultComponent.id, version: 1 } },
    ],
    edges: [
      {
        id: 'run-result',
        from: { node: 'run', port: 'event' },
        to: { node: 'result', port: 'value' },
      },
    ],
  });
}

export function reviewHuddleFixture() {
  const schema = {
    type: 'object',
    properties: { complete: { type: 'boolean' }, feedback: { type: 'string' } },
    required: ['complete', 'feedback'],
    additionalProperties: false,
  };
  const agent = huddleComponentSchema.parse({
    format: 1,
    id: 'project.agent.prompt',
    version: 1,
    category: 'script',
    title: 'Prompt agent',
    inputs: { request: { schema: {} } },
    outputs: { completed: { schema } },
    capabilities: ['sessions'],
    parameters: {
      worktree: { schema: { type: 'string', minLength: 1 }, editor: 'worktree' },
      agent: { schema: { type: 'string', minLength: 1 }, editor: 'session' },
    },
    entry: './run.ts',
  });
  const definition = huddleDefinitionSchema.parse({
    format: 1,
    id: huddleFixtureId,
    name: 'Review loop',
    variables: {
      worktree: { schema: { type: 'string', minLength: 1 }, editor: 'worktree' },
      coder: { schema: { type: 'string', minLength: 1 }, editor: 'session' },
      reviewer: { schema: { type: 'string', minLength: 1 }, editor: 'session' },
    },
    nodes: [
      manualHuddleFixture().nodes[0],
      ...['coder', 'reviewer'].map((id) => ({
        id,
        source: { kind: 'local', manifest: `./nodes/${id}/node.json` },
        parameters: {
          worktree: { kind: 'variable', name: 'worktree' },
          agent: { kind: 'variable', name: id },
        },
      })),
    ],
    edges: [
      { id: 'seed', from: { node: 'run', port: 'event' }, to: { node: 'coder', port: 'request' } },
      {
        id: 'review',
        from: { node: 'coder', port: 'completed' },
        to: { node: 'reviewer', port: 'request' },
      },
      {
        id: 'revise',
        from: { node: 'reviewer', port: 'completed' },
        to: { node: 'coder', port: 'request' },
        feedback: { maxRounds: 5, while: { path: ['complete'], equals: false } },
      },
    ],
  });
  return {
    definition,
    agent,
    components: new Map([
      ['run', manualComponent],
      ['coder', agent],
      ['reviewer', agent],
    ]),
  };
}
