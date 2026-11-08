import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { huddleEmissionRecordSchema } from '@puddle/shared';
import {
  huddleLedgerFixture,
  runningHuddleInvocation,
  type HuddleLedgerFixture,
} from '../../helpers/huddle/ledger.js';

const fixtures: HuddleLedgerFixture[] = [];
function setup() {
  const f = huddleLedgerFixture();
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

describe('durable huddle node execution and outbox', () => {
  it('enforces node concurrency before starting a second invocation', () => {
    const f = setup();
    const { invocation, execution } = runningHuddleInvocation(f);
    const next = {
      id: randomUUID(),
      executionId: execution.id,
      revision: invocation.revision,
      node: invocation.node,
      activation: 'next',
      iteration: 1,
      inputs: {},
    };
    f.ledger.invocations.queue(next);
    expect(() => f.ledger.invocations.start(next.id)).toThrow('node concurrency');
    expect(f.ledger.invocations.get(next.id).state).toBe('pending');
    f.ledger.invocations.complete(invocation.id, {});
    expect(f.ledger.invocations.start(next.id).state).toBe('running');
  });
  it('atomically records completion and outgoing ports and never runs the same activation twice', () => {
    const f = setup();
    const { execution, invocation } = runningHuddleInvocation(f);
    f.ledger.invocations.complete(invocation.id, {
      completed: { complete: false, feedback: 'revise' },
    });
    f.reopen();
    expect(f.ledger.invocations.get(invocation.id).state).toBe('completed');
    expect(f.ledger.page('emissions', { parent: execution.id })).toHaveLength(1);
    expect(() => f.ledger.invocations.start(invocation.id)).toThrow('again');
    expect(
      f.ledger.invocations.complete(invocation.id, {
        completed: { feedback: 'revise', complete: false },
      }).state,
    ).toBe('completed');
    expect(() => f.ledger.invocations.complete(invocation.id, { completed: true })).toThrow(
      'conflicts',
    );
    expect(
      f.ledger.invocations.queue({
        id: randomUUID(),
        executionId: execution.id,
        revision: invocation.revision,
        node: invocation.node,
        activation: invocation.activation,
        iteration: 0,
        inputs: invocation.inputs,
      }).duplicate,
    ).toBe(true);
    expect(() => f.ledger.executions.finish(execution.id, 'completed')).toThrow('pending work');
  });

  it('rolls back routing acknowledgement and child admission together on failure', () => {
    const f = setup();
    const { execution, invocation } = runningHuddleInvocation(f);
    f.ledger.invocations.complete(invocation.id, { completed: 'reply' });
    const child = {
      id: randomUUID(),
      executionId: execution.id,
      revision: invocation.revision,
      node: 'reviewer',
      activation: 'reply-1',
      iteration: 0,
      inputs: { request: 'reply' },
    };
    expect(() =>
      f.ledger.invocations.route(invocation.id, 1, () => {
        f.ledger.invocations.queue(child);
        throw new Error('Injected route failure');
      }),
    ).toThrow('Injected route failure');
    expect(() => f.ledger.invocations.get(child.id)).toThrow('does not exist');
    expect(f.ledger.executions.get(execution.id).invocations).toBe(1);
    const consume = vi.fn(() => {
      f.ledger.invocations.queue(child);
    });
    expect(f.ledger.invocations.route(invocation.id, 1, consume)).toBe(true);
    expect(f.ledger.invocations.route(invocation.id, 1, consume)).toBe(false);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(f.ledger.invocations.get(child.id).state).toBe('pending');
  });

  it('retains exact emission sequence and refuses conflicting or late emissions', () => {
    const f = setup();
    const { invocation } = runningHuddleInvocation(f);
    f.ledger.invocations.emit(invocation.id, 1, 'turn', 'reply');
    f.reopen();
    expect(f.ledger.invocations.emit(invocation.id, 1, 'turn', 'reply').duplicate).toBe(true);
    expect(() => f.ledger.invocations.emit(invocation.id, 1, 'turn', 'different')).toThrow(
      'conflicts',
    );
    expect(() => f.ledger.invocations.emit(invocation.id, 3, 'turn', 'skip')).toThrow('sequence');
    f.ledger.invocations.complete(invocation.id, { completed: true });
    const emissions = f.ledger
      .page('emissions')
      .map((row) => huddleEmissionRecordSchema.parse(JSON.parse(row.body)));
    expect(emissions.map((e) => [e.sequence, e.kind])).toEqual([
      [1, 'event'],
      [2, 'completion'],
    ]);
    expect(() => f.ledger.invocations.emit(invocation.id, 3, 'turn', 'late')).toThrow(
      'after node completion',
    );
  });

  it('does not complete while an external operation is unresolved', () => {
    const f = setup();
    const { invocation } = runningHuddleInvocation(f);
    const operation = {
      id: randomUUID(),
      invocationId: invocation.id,
      kind: 'ask' as const,
      target: { runtime: randomUUID() },
      input: 'prompt',
    };
    f.ledger.operations.prepare(operation);
    expect(() => f.ledger.invocations.complete(invocation.id, { completed: true })).toThrow(
      'unresolved operations',
    );
    f.ledger.operations.dispatch(operation.id);
    f.ledger.operations.unknown(operation.id, 'Reply lost');
    expect(() => f.ledger.invocations.complete(invocation.id, { completed: true })).toThrow(
      'unresolved operations',
    );
    f.ledger.operations.settle(operation.id, 'completed', 'reply');
    expect(f.ledger.invocations.complete(invocation.id, { completed: true }).state).toBe(
      'completed',
    );
  });
});
