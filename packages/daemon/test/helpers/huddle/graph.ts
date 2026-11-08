import {
  huddleComponentSchema,
  huddleDefinitionSchema,
  huddleInvocationRecordSchema,
  type HuddleDefinition,
  type HuddleJson,
} from '@puddle/shared';
import { manualComponent } from '../../../../shared/test/helpers/huddle.js';
import type { HuddleLedgerFixture } from './ledger.js';

export function diamondGraph(f: HuddleLedgerFixture) {
  const branch = huddleComponentSchema.parse({
    format: 1,
    id: 'fixture.script.branch',
    version: 1,
    category: 'script',
    title: 'Branch',
    inputs: { request: { schema: {} } },
    outputs: { completed: { schema: {} } },
  });
  const join = huddleComponentSchema.parse({
    format: 1,
    id: 'fixture.script.join',
    version: 1,
    category: 'script',
    title: 'Join',
    inputs: { left: { schema: {} }, right: { schema: {} } },
    outputs: {},
  });
  const components = new Map([
    ['run', manualComponent],
    ['left', branch],
    ['right', branch],
    ['join', join],
  ]);
  const definition = huddleDefinitionSchema.parse({
    format: 1,
    id: f.identity.huddleId,
    name: 'Diamond',
    nodes: [...components].map(([id, component]) => ({
      id,
      source: { kind: 'builtin', component: component.id, version: component.version },
    })),
    edges: ['left', 'right'].flatMap((side) => [
      {
        id: `run-${side}`,
        from: { node: 'run', port: 'event' },
        to: { node: side, port: 'request' },
      },
      {
        id: `${side}-join`,
        from: { node: side, port: 'completed' },
        to: { node: 'join', port: side },
      },
    ]),
  });
  return { definition, components };
}

export function acceptGraph(
  f: HuddleLedgerFixture,
  definition: HuddleDefinition,
  previous: HuddleJson = null,
  next: HuddleJson = 1,
) {
  const event = f.event();
  f.ledger.executions.accept(event, previous, next, definition.execution);
  return event;
}

export function invocations(f: HuddleLedgerFixture, executionId: string, node?: string) {
  return f.ledger
    .page('invocations', { parent: executionId })
    .map((row) => huddleInvocationRecordSchema.parse(JSON.parse(row.body)))
    .filter((record) => node === undefined || record.node === node);
}

export function completeNode(
  f: HuddleLedgerFixture,
  executionId: string,
  node: string,
  outputs: Record<string, HuddleJson>,
) {
  const pending = invocations(f, executionId, node).find((record) => record.state === 'pending');
  if (!pending) throw new Error(`No pending ${node} invocation`);
  f.ledger.invocations.start(pending.id);
  return f.ledger.invocations.complete(pending.id, outputs);
}
