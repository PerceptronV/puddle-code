import { afterEach, describe, expect, it } from 'vitest';
import { huddleComponentSchema, huddleDefinitionSchema } from '@puddle/shared';
import { huddleLedgerFixture, type HuddleLedgerFixture } from '../../helpers/huddle/ledger.js';
import { acceptGraph, diamondGraph, invocations } from '../../helpers/huddle/graph.js';

const fixtures: HuddleLedgerFixture[] = [];
function setup(maxInvocations = 512) {
  const f = huddleLedgerFixture();
  fixtures.push(f);
  const { definition, components } = diamondGraph(f);
  const emitter = huddleComponentSchema.parse({
    ...components.get('left'),
    id: 'fixture.script.events',
    outputs: { turn: { schema: {}, emission: 'event', required: false } },
  });
  components.set('emitter', emitter);
  definition.nodes.push(
    huddleDefinitionSchema.shape.nodes.element.parse({
      id: 'emitter',
      source: { kind: 'builtin', component: emitter.id, version: 1 },
    }),
  );
  for (const edge of definition.edges) {
    if (edge.from.node === 'run') edge.from = { node: 'emitter', port: 'turn' };
  }
  definition.edges.push({
    id: 'run-emitter',
    from: { node: 'run', port: 'event' },
    to: { node: 'emitter', port: 'request' },
  });
  definition.execution.maxInvocations = maxInvocations;
  return { f, definition, components };
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

describe('explicit event ports', () => {
  it('does not dispatch pending output after its source fails', () => {
    const { f, definition, components } = setup();
    const event = acceptGraph(f, definition);
    const graph = f.ledger.graph(event.revision, definition, components);
    graph.start(event.executionId);
    const emitter = invocations(f, event.executionId, 'emitter')[0]!;
    f.ledger.invocations.start(emitter.id);
    f.ledger.invocations.emit(emitter.id, 1, 'turn', 'not yet routed');
    f.ledger.invocations.finish(emitter.id, 'failed', 'Source failed');
    expect(() => graph.route(emitter.id, 1)).toThrow('unsuccessful invocation');
    expect(invocations(f, event.executionId)).toHaveLength(1);
  });
  it('gives each event emission a separate fan-out cohort while preserving joins within it', () => {
    const { f, definition, components } = setup();
    const event = acceptGraph(f, definition);
    const graph = () => f.ledger.graph(event.revision, definition, components);
    graph().start(event.executionId);
    const emitter = invocations(f, event.executionId, 'emitter')[0]!;
    f.ledger.invocations.start(emitter.id);
    for (let sequence = 1; sequence <= 2; sequence++) {
      f.ledger.invocations.emit(emitter.id, sequence, 'turn', sequence);
      graph().route(emitter.id, sequence);
    }
    f.reopen();
    expect(graph().route(emitter.id, 1)).toBe(false);
    const left = invocations(f, event.executionId, 'left');
    const right = invocations(f, event.executionId, 'right');
    expect(left[0]!.activation).not.toBe(left[1]!.activation);
    for (const record of [left[0]!, right[1]!, left[1]!, right[0]!]) {
      f.ledger.invocations.start(record.id);
      f.ledger.invocations.complete(record.id, {
        completed: (record.inputs as { request: number }).request,
      });
      graph().route(record.id, 1);
    }
    const joins = invocations(f, event.executionId, 'join');
    expect(joins.map((record) => record.inputs)).toEqual([
      { left: 2, right: 2 },
      { left: 1, right: 1 },
    ]);
    f.ledger.invocations.complete(emitter.id, {});
    for (const join of joins) {
      f.ledger.invocations.start(join.id);
      f.ledger.invocations.complete(join.id, {});
    }
    expect(f.ledger.executions.finish(event.executionId, 'completed').state).toBe('completed');
  });

  it('rolls back emission acknowledgement and all fan-out admissions on shared budget exhaustion', () => {
    const { f, definition, components } = setup(2);
    const event = acceptGraph(f, definition);
    const graph = f.ledger.graph(event.revision, definition, components);
    graph.start(event.executionId);
    const emitter = invocations(f, event.executionId, 'emitter')[0]!;
    f.ledger.invocations.start(emitter.id);
    f.ledger.invocations.emit(emitter.id, 1, 'turn', 'reply');
    expect(() => graph.route(emitter.id, 1)).toThrow('invocations limit');
    expect(invocations(f, event.executionId)).toHaveLength(1);
    expect(f.ledger.executions.get(event.executionId).invocations).toBe(1);
    expect(f.ledger.page('emissions', { state: 'pending' })).toHaveLength(1);
    expect(f.ledger.page('joins')).toHaveLength(1);
  });

  it('validates every destination and rejects completion records forged for event ports', () => {
    const { f, definition, components } = setup();
    components.set(
      'right',
      huddleComponentSchema.parse({
        ...components.get('right'),
        inputs: { request: { schema: { type: 'string' } } },
      }),
    );
    const event = acceptGraph(f, definition);
    const graph = f.ledger.graph(event.revision, definition, components);
    graph.start(event.executionId);
    const emitter = invocations(f, event.executionId, 'emitter')[0]!;
    f.ledger.invocations.start(emitter.id);
    f.ledger.invocations.emit(emitter.id, 1, 'turn', 17);
    expect(() => graph.route(emitter.id, 1)).toThrow('Invalid graph input: right.request');
    expect(invocations(f, event.executionId)).toHaveLength(1);
    f.ledger.invocations.complete(emitter.id, { turn: 'forged completion' });
    expect(() => graph.route(emitter.id, 2)).toThrow('Emission kind');
  });
});
