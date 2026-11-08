import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  huddleLedgerFixture,
  runningHuddleInvocation,
  type HuddleLedgerFixture,
} from '../../helpers/huddle/ledger.js';

const fixtures: HuddleLedgerFixture[] = [];
function setup(limits?: { bytes?: number; records?: number }) {
  const f = huddleLedgerFixture(limits);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

describe('huddle external operation consumption', () => {
  it('retains dispatch consumption after lost replies and permits observation-only settlement', () => {
    const f = setup();
    const { invocation } = runningHuddleInvocation(f);
    const input = {
      id: randomUUID(),
      invocationId: invocation.id,
      kind: 'ask' as const,
      target: { runtimeId: randomUUID(), turn: 1 },
      input: 'prompt',
    };
    f.ledger.operations.prepare(input);
    f.ledger.operations.dispatch(input.id);
    f.reopen();
    expect(f.ledger.operations.prepare(input)).toMatchObject({
      duplicate: true,
      record: { consumed: true, state: 'dispatched' },
    });
    expect(() => f.ledger.operations.dispatch(input.id)).toThrow('already consumed');
    f.ledger.operations.unknown(input.id, 'Reply lost');
    expect(() => f.ledger.operations.cancelUnsent(input.id)).toThrow('reconciliation');
    expect(() => f.ledger.operations.dispatch(input.id)).toThrow('already consumed');
    expect(f.ledger.operations.settle(input.id, 'completed', 'reply')).toMatchObject({
      state: 'completed',
      consumed: true,
    });
    expect(f.ledger.operations.settle(input.id, 'completed', 'reply').result).toBe('reply');
    expect(() => f.ledger.operations.settle(input.id, 'completed', 'different')).toThrow(
      'conflicts',
    );
    expect(() =>
      f.ledger.operations.prepare({ ...input, target: { runtimeId: randomUUID(), turn: 1 } }),
    ).toThrow('conflicts');
  });

  it('spends budgets atomically with dispatch and never resets them after reopen', () => {
    const f = setup();
    f.settings.maxTurns = 1;
    f.settings.maxAgents = 1;
    f.settings.maxInvocations = 1;
    const { execution, invocation } = runningHuddleInvocation(f);
    const ask = {
      id: randomUUID(),
      invocationId: invocation.id,
      kind: 'ask' as const,
      target: 'agent',
      input: 'prompt',
    };
    f.ledger.operations.prepare(ask);
    f.ledger.operations.dispatch(ask.id);
    const spawn = { ...ask, id: randomUUID(), kind: 'spawn' as const, target: 'worktree' };
    f.ledger.operations.prepare(spawn);
    f.ledger.operations.dispatch(spawn.id);
    f.reopen();
    const again = { ...ask, id: randomUUID() };
    f.ledger.operations.prepare(again);
    expect(() => f.ledger.operations.dispatch(again.id)).toThrow('turns limit');
    expect(f.ledger.operations.get(again.id)).toMatchObject({ consumed: false, state: 'prepared' });
    expect(f.ledger.executions.get(execution.id)).toMatchObject({
      turns: 1,
      spawns: 1,
      invocations: 1,
    });
    expect(() =>
      f.ledger.invocations.queue({
        id: randomUUID(),
        executionId: execution.id,
        revision: invocation.revision,
        node: 'reviewer',
        activation: 'second',
        iteration: 0,
        inputs: {},
      }),
    ).toThrow('invocations limit');
  });

  it('reserves outcome bytes and completion rows before accepting more inbox work', () => {
    const f = setup({ records: 100, bytes: 2 * 1024 * 1024 });
    const { invocation } = runningHuddleInvocation(f);
    const operation = {
      id: randomUUID(),
      invocationId: invocation.id,
      kind: 'readout' as const,
      target: 'service',
      input: 'payload',
    };
    f.ledger.operations.prepare(operation);
    f.ledger.operations.dispatch(operation.id);
    let cursor = 1;
    for (let i = 0; i < 100; i++) {
      try {
        f.ledger.executions.accept(
          f.event({ data: 'x'.repeat(60_000) }),
          cursor,
          cursor + 1,
          f.settings,
        );
        cursor++;
      } catch (error) {
        expect(String(error)).toContain('capacity');
        break;
      }
    }
    expect(cursor).toBeGreaterThan(1);
    expect(cursor).toBeLessThan(100);
    expect(f.ledger.operations.settle(operation.id, 'completed', 'y'.repeat(250_000)).state).toBe(
      'completed',
    );
    const outputs = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`port${index}`, true]),
    );
    expect(f.ledger.invocations.complete(invocation.id, outputs).lastEmission).toBe(64);
    expect(f.ledger.page('emissions')).toHaveLength(64);
    f.reopen();
    expect(f.ledger.operations.get(operation.id).result).toHaveLength(250_000);
  });

  it('fences interrupted work while preserving late exact outcomes and unstarted root events', () => {
    const f = setup();
    const { execution, invocation } = runningHuddleInvocation(f);
    const first = {
      id: randomUUID(),
      invocationId: invocation.id,
      kind: 'ask' as const,
      target: 'agent',
      input: 'prompt',
    };
    const unsent = { ...first, id: randomUUID(), input: 'later' };
    f.ledger.operations.prepare(first);
    f.ledger.operations.dispatch(first.id);
    f.ledger.operations.prepare(unsent);
    f.ledger.invocations.emit(invocation.id, 1, 'turn', 'retained');
    const queued = f.event();
    f.ledger.executions.accept(queued, 1, 2, f.settings);
    f.reopen();
    expect(f.ledger.recoverOwnerLoss()).toEqual([execution.id]);
    expect(f.ledger.operations.get(first.id)).toMatchObject({ state: 'unknown', consumed: true });
    expect(f.ledger.operations.get(unsent.id)).toMatchObject({
      state: 'cancelled',
      consumed: false,
    });
    expect(f.ledger.invocations.get(invocation.id).state).toBe('interrupted');
    expect(f.ledger.executions.get(queued.executionId).state).toBe('pending');
    expect(f.ledger.page('emissions')[0]?.state).toBe('cancelled');
    expect(f.ledger.recoverOwnerLoss()).toEqual([]);
    expect(f.ledger.operations.settle(first.id, 'completed', 'late reply').result).toBe(
      'late reply',
    );
    expect(() => f.ledger.invocations.complete(invocation.id, {})).toThrow('not running');
    expect(() => f.ledger.operations.dispatch(first.id)).toThrow('not running');
  });
});
