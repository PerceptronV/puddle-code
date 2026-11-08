import { afterEach, describe, expect, it } from 'vitest';
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
  return { f, ...diamondGraph(f) };
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

describe('durable huddle joins and alternatives', () => {
  it('never joins different root events and retains partial joins across reopen', () => {
    const { f, definition, components } = setup();
    definition.execution.concurrency = 2;
    const a = acceptGraph(f, definition);
    const b = acceptGraph(f, definition, 1, 2);
    const graph = () => f.ledger.graph(a.revision, definition, components);
    graph().start(a.executionId);
    graph().start(b.executionId);
    const leftA = completeNode(f, a.executionId, 'left', { completed: 'a-left' });
    const rightB = completeNode(f, b.executionId, 'right', { completed: 'b-right' });
    graph().route(leftA.id, 1);
    graph().route(rightB.id, 1);
    f.reopen();
    expect(invocations(f, a.executionId, 'join')).toHaveLength(0);
    expect(invocations(f, b.executionId, 'join')).toHaveLength(0);
    const rightA = completeNode(f, a.executionId, 'right', { completed: 'a-right' });
    graph().route(rightA.id, 1);
    expect(invocations(f, a.executionId, 'join')[0]!.inputs).toEqual({
      left: 'a-left',
      right: 'a-right',
    });
    expect(invocations(f, b.executionId, 'join')).toHaveLength(0);
    expect(graph().route(rightA.id, 1)).toBe(false);
    const leftB = completeNode(f, b.executionId, 'left', { completed: 'b-left' });
    graph().route(leftB.id, 1);
    expect(invocations(f, b.executionId, 'join')[0]!.inputs).toEqual({
      left: 'b-left',
      right: 'b-right',
    });
  });

  it('admits every explicit alternative independently and snapshots optional inputs at readiness', () => {
    const { f, definition, components } = setup();
    components.set(
      'join',
      huddleComponentSchema.parse({ ...components.get('join'), activation: 'any' }),
    );
    const event = acceptGraph(f, definition);
    const graph = f.ledger.graph(event.revision, definition, components);
    graph.start(event.executionId);
    for (const side of ['left', 'right']) {
      const done = completeNode(f, event.executionId, side, { completed: side });
      graph.route(done.id, 1);
    }
    const admitted = invocations(f, event.executionId, 'join');
    expect(admitted.map((record) => record.inputs)).toEqual([{ left: 'left' }, { right: 'right' }]);
    expect(admitted[0]!.activation).not.toBe(admitted[1]!.activation);
  });

  it('does not revise an admitted invocation when an optional input arrives later', () => {
    const { f, definition, components } = setup();
    const join = components.get('join')!;
    components.set(
      'join',
      huddleComponentSchema.parse({
        ...join,
        inputs: { ...join.inputs, right: { schema: {}, required: false } },
      }),
    );
    const event = acceptGraph(f, definition);
    const graph = f.ledger.graph(event.revision, definition, components);
    graph.start(event.executionId);
    for (const side of ['left', 'right']) {
      const done = completeNode(f, event.executionId, side, { completed: side });
      graph.route(done.id, 1);
    }
    expect(invocations(f, event.executionId, 'join').map((record) => record.inputs)).toEqual([
      { left: 'left' },
    ]);
  });

  it('rolls back all trigger fan-out when its shared invocation budget is exhausted', () => {
    const { f, definition, components } = setup();
    definition.execution.maxInvocations = 1;
    const event = acceptGraph(f, definition);
    const graph = f.ledger.graph(event.revision, definition, components);
    expect(() => graph.start(event.executionId)).toThrow('invocations limit');
    expect(f.ledger.executions.get(event.executionId)).toMatchObject({
      state: 'pending',
      invocations: 0,
    });
    expect(f.ledger.page('invocations')).toHaveLength(0);
    expect(f.ledger.page('joins')).toHaveLength(0);
    expect(f.ledger.page('graph-starts')).toHaveLength(0);
  });

  it('cannot claim successful completion with an unsatisfied join or failed branch', () => {
    const { f, definition, components } = setup();
    const event = acceptGraph(f, definition);
    const graph = f.ledger.graph(event.revision, definition, components);
    graph.start(event.executionId);
    const left = completeNode(f, event.executionId, 'left', { completed: 'left' });
    graph.route(left.id, 1);
    const right = invocations(f, event.executionId, 'right')[0]!;
    f.ledger.invocations.finish(right.id, 'failed', 'No result');
    expect(() => f.ledger.executions.finish(event.executionId, 'completed')).toThrow(
      'pending work',
    );
    f.ledger.interrupt(event.executionId, 'interrupted', 'Branch failed');
    expect(f.ledger.page('joins', { state: 'waiting' })).toHaveLength(0);
    expect(f.ledger.page('joins', { state: 'cancelled' })).toHaveLength(1);
  });
});
