import { afterEach, expect, it } from 'vitest';
import { huddleComponentSchema } from '@puddle/shared';
import { huddleLedgerFixture, type HuddleLedgerFixture } from '../../helpers/huddle/ledger.js';
import {
  acceptGraph,
  completeNode,
  diamondGraph,
  invocations,
} from '../../helpers/huddle/graph.js';

const fixtures: HuddleLedgerFixture[] = [];
function setup() {
  const f = huddleLedgerFixture();
  fixtures.push(f);
  const { definition, components } = diamondGraph(f);
  components.set(
    'join',
    huddleComponentSchema.parse({
      ...components.get('join'),
      inputs: { left: { schema: {}, scope: 'execution' }, right: { schema: {} } },
      outputs: {
        completed: {
          schema: {
            type: 'object',
            properties: { complete: { type: 'boolean' } },
            required: ['complete'],
          },
        },
      },
    }),
  );
  definition.edges.push({
    id: 'again',
    from: { node: 'join', port: 'completed' },
    to: { node: 'join', port: 'right' },
    feedback: { maxRounds: 3, while: { path: ['complete'], equals: false } },
  });
  return { f, definition, components };
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

it.each(['left', 'right'])(
  'retains one input across feedback and ledger reopening, arriving %s first',
  (first) => {
    const { f, definition, components } = setup();
    const event = acceptGraph(f, definition);
    const graph = () => f.ledger.graph(event.revision, definition, components);
    graph().start(event.executionId);
    const deliver = (side: string) => {
      const node = completeNode(f, event.executionId, side, { completed: side });
      graph().route(node.id, 1);
    };
    deliver(first);
    expect(invocations(f, event.executionId, 'join')).toHaveLength(0);
    f.reopen();
    deliver(first === 'left' ? 'right' : 'left');
    expect(invocations(f, event.executionId, 'join')[0]?.inputs).toEqual({
      left: 'left',
      right: 'right',
    });
    const done = completeNode(f, event.executionId, 'join', { completed: { complete: false } });
    graph().route(done.id, 1);
    f.reopen();
    const rounds = invocations(f, event.executionId, 'join');
    expect(rounds[1]).toMatchObject({
      iteration: 1,
      inputs: { left: 'left', right: { complete: false } },
    });
    expect(rounds[1]?.activation).not.toBe(rounds[0]?.activation);
    expect(graph().route(done.id, 1)).toBe(false);
    expect(f.ledger.page('execution-inputs')).toHaveLength(1);
    const last = completeNode(f, event.executionId, 'join', { completed: { complete: true } });
    graph().route(last.id, 1);
    expect(f.ledger.executions.finish(event.executionId, 'completed').state).toBe('completed');
  },
);

it('never supplies a retained input to another execution', () => {
  const { f, definition, components } = setup();
  definition.execution.concurrency = 2;
  const a = acceptGraph(f, definition),
    b = acceptGraph(f, definition, 1, 2);
  const graph = f.ledger.graph(a.revision, definition, components);
  graph.start(a.executionId);
  graph.start(b.executionId);
  graph.route(completeNode(f, a.executionId, 'left', { completed: 'a-agent' }).id, 1);
  graph.route(completeNode(f, b.executionId, 'right', { completed: 'b-task' }).id, 1);
  expect(invocations(f, b.executionId, 'join')).toHaveLength(0);
  graph.route(completeNode(f, b.executionId, 'left', { completed: 'b-agent' }).id, 1);
  expect(invocations(f, b.executionId, 'join')[0]?.inputs).toEqual({
    left: 'b-agent',
    right: 'b-task',
  });
  expect(invocations(f, a.executionId, 'join')).toHaveLength(0);
});

it.each([3, 512])('releases waiting cohorts atomically within a %i invocation budget', (budget) => {
  const { f, definition, components } = setup();
  definition.execution.maxInvocations = budget;
  components.set(
    'right',
    huddleComponentSchema.parse({
      ...components.get('right'),
      outputs: { tick: { schema: {}, emission: 'event', required: false } },
    }),
  );
  definition.edges.find((edge) => edge.id === 'right-join')!.from.port = 'tick';
  const event = acceptGraph(f, definition);
  const graph = () => f.ledger.graph(event.revision, definition, components);
  graph().start(event.executionId);
  const right = invocations(f, event.executionId, 'right')[0]!;
  f.ledger.invocations.start(right.id);
  for (let i = 1; i <= 2; i++) {
    f.ledger.invocations.emit(right.id, i, 'tick', `task-${i}`);
    graph().route(right.id, i);
  }
  expect(invocations(f, event.executionId, 'join')).toHaveLength(0);
  f.reopen();
  const left = completeNode(f, event.executionId, 'left', { completed: 'agent' });
  if (budget === 3) {
    expect(() => graph().route(left.id, 1)).toThrow('invocations limit');
    f.reopen();
    expect(invocations(f, event.executionId, 'join')).toHaveLength(0);
    expect(f.ledger.page('execution-inputs')).toHaveLength(0);
    expect(f.ledger.page('joins', { state: 'waiting' })).toHaveLength(2);
    expect(f.ledger.executions.get(event.executionId).invocations).toBe(2);
    return;
  }
  graph().route(left.id, 1);
  expect(invocations(f, event.executionId, 'join').map((row) => row.inputs)).toEqual([
    { right: 'task-1', left: 'agent' },
    { right: 'task-2', left: 'agent' },
  ]);
});

it('rejects a second delivery even with the same value, preserving the first and leaving the emission unacknowledged', () => {
  const { f, definition, components } = setup();
  components.set(
    'left',
    huddleComponentSchema.parse({
      ...components.get('left'),
      outputs: { tick: { schema: {}, emission: 'event', required: false } },
    }),
  );
  definition.edges.find((edge) => edge.id === 'left-join')!.from.port = 'tick';
  const event = acceptGraph(f, definition);
  const graph = () => f.ledger.graph(event.revision, definition, components);
  graph().start(event.executionId);
  const left = invocations(f, event.executionId, 'left')[0]!;
  f.ledger.invocations.start(left.id);
  f.ledger.invocations.emit(left.id, 1, 'tick', 'agent');
  graph().route(left.id, 1);
  const before = f.ledger.page('execution-inputs');
  f.ledger.invocations.emit(left.id, 2, 'tick', 'agent');
  expect(() => graph().route(left.id, 2)).toThrow('compete');
  f.reopen();
  expect(f.ledger.page('execution-inputs')).toEqual(before);
  expect(() => graph().route(left.id, 2)).toThrow('compete');
});
