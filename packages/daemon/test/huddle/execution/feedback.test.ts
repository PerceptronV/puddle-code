import { afterEach, describe, expect, it } from 'vitest';
import { reviewHuddleFixture } from '../../../../shared/test/helpers/huddle.js';
import { HuddleFeedbackLimitError } from '../../../src/runtime/huddle/execution/graph.js';
import { huddleLedgerFixture, type HuddleLedgerFixture } from '../../helpers/huddle/ledger.js';
import { acceptGraph, completeNode, invocations } from '../../helpers/huddle/graph.js';

const fixtures: HuddleLedgerFixture[] = [];
function setup(maxRounds = 5) {
  const f = huddleLedgerFixture();
  fixtures.push(f);
  const { definition, components } = reviewHuddleFixture();
  definition.id = f.identity.huddleId;
  definition.edges[2]!.feedback!.maxRounds = maxRounds;
  const event = acceptGraph(f, definition);
  const graph = () => f.ledger.graph(event.revision, definition, components);
  graph().start(event.executionId);
  return { f, definition, components, event, graph };
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

describe('bounded two-agent graph routing', () => {
  it('routes coder/reviewer exchanges into new iterations and exits on approval across reopen', () => {
    const { f, event, graph } = setup();
    for (let round = 0; round < 3; round++) {
      const coder = completeNode(f, event.executionId, 'coder', {
        completed: { complete: false, feedback: `draft ${round}` },
      });
      expect(coder.iteration).toBe(round);
      expect(graph().route(coder.id, 1)).toBe(true);
      f.reopen();
      expect(graph().route(coder.id, 1)).toBe(false);
      const reviewer = completeNode(f, event.executionId, 'reviewer', {
        completed: { complete: round === 2, feedback: `review ${round}` },
      });
      expect(reviewer.activation).toBe(coder.activation);
      graph().route(reviewer.id, 1);
      f.reopen();
    }
    expect(invocations(f, event.executionId)).toHaveLength(6);
    expect(
      new Set(invocations(f, event.executionId, 'coder').map((record) => record.activation)).size,
    ).toBe(3);
    expect(graph().start(event.executionId)).toBe(false);
    expect(f.ledger.executions.get(event.executionId).invocations).toBe(6);
    expect(f.ledger.executions.finish(event.executionId, 'completed').state).toBe('completed');
  });

  it('exhausts a configured round limit without admitting another prompt or acknowledging success', () => {
    const { f, event, graph } = setup(2);
    for (let round = 0; round < 2; round++) {
      const coder = completeNode(f, event.executionId, 'coder', {
        completed: { complete: false, feedback: 'draft' },
      });
      graph().route(coder.id, 1);
      const reviewer = completeNode(f, event.executionId, 'reviewer', {
        completed: { complete: false, feedback: 'revise' },
      });
      if (round === 0) graph().route(reviewer.id, 1);
      else {
        expect(() => graph().route(reviewer.id, 1)).toThrow(HuddleFeedbackLimitError);
        f.reopen();
        expect(() => graph().route(reviewer.id, 1)).toThrow('2-round limit');
      }
    }
    expect(invocations(f, event.executionId)).toHaveLength(4);
    expect(() => f.ledger.executions.finish(event.executionId, 'completed')).toThrow(
      'pending work',
    );
    f.ledger.interrupt(event.executionId, 'interrupted', 'Round limit');
    expect(f.ledger.page('emissions', { state: 'pending' })).toHaveLength(0);
  });

  it('rejects missing/nonboolean feedback values and wrong revisions before routing', () => {
    const { f, event, graph, definition, components } = setup();
    const coder = completeNode(f, event.executionId, 'coder', {
      completed: { complete: false, feedback: 'draft' },
    });
    graph().route(coder.id, 1);
    const reviewer = completeNode(f, event.executionId, 'reviewer', {
      completed: { feedback: 'not approval' },
    });
    expect(() => graph().route(reviewer.id, 1)).toThrow('Invalid graph output');
    const other = f.ledger.graph('b'.repeat(64), definition, components);
    expect(() => other.route(reviewer.id, 1)).toThrow('another revision');
    expect(invocations(f, event.executionId, 'coder')).toHaveLength(1);
  });
});
