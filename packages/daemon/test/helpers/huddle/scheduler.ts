import {
  huddleComponentSchema,
  huddleDefinitionSchema,
  type HuddleComponent,
} from '@puddle/shared';
import { manualHuddleTrigger, huddleResultReadout } from '@puddle/shared';
import { huddleRevisionDigest } from '../../../src/huddle/definitions/revision.js';
import type { HuddleDefinitionSnapshot } from '../../../src/huddle/definitions/capture.js';

export function schedulerSnapshot(
  huddleId: string,
  source: string,
  feedback?: number,
): HuddleDefinitionSnapshot {
  const component: HuddleComponent = huddleComponentSchema.parse({
    format: 1,
    id: 'fixture.script.scheduler',
    version: 1,
    title: 'Script',
    category: 'script',
    entry: './run.ts',
    inputs: { value: { schema: {} } },
    outputs: {
      completed: {
        schema: feedback
          ? {
              type: 'object',
              properties: { complete: { type: 'boolean' }, count: { type: 'number' } },
              required: ['complete', 'count'],
            }
          : {},
      },
      turn: { schema: {}, emission: 'event', required: false },
    },
  });
  const definition = huddleDefinitionSchema.parse({
    format: 1,
    id: huddleId,
    name: 'Scheduler fixture',
    nodes: [
      { id: 'run', source: { kind: 'builtin', component: manualHuddleTrigger.id, version: 1 } },
      { id: 'worker', source: { kind: 'local', manifest: './nodes/example/node.json' } },
      { id: 'result', source: { kind: 'builtin', component: huddleResultReadout.id, version: 1 } },
    ],
    edges: [
      { id: 'seed', from: { node: 'run', port: 'event' }, to: { node: 'worker', port: 'value' } },
      {
        id: 'result',
        from: { node: 'worker', port: 'completed' },
        to: { node: 'result', port: 'value' },
      },
      ...(feedback
        ? [
            {
              id: 'again',
              from: { node: 'worker', port: 'completed' },
              to: { node: 'worker', port: 'value' },
              feedback: { maxRounds: feedback, while: { path: ['complete'], equals: false } },
            },
          ]
        : []),
    ],
  });
  const files = {
    'huddle.json': JSON.stringify(definition),
    'nodes/example/node.json': JSON.stringify(component),
    'nodes/example/run.ts': source,
  };
  const components = { run: manualHuddleTrigger, worker: component, result: huddleResultReadout };
  return {
    format: 1,
    digest: huddleRevisionDigest(files, components),
    definition,
    files,
    components,
    diagnostics: [],
  };
}
