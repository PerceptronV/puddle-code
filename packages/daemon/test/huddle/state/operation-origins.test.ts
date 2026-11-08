import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import type { RuntimeIdentity } from '@puddle/shared';
import { HuddleLedger } from '../../../src/runtime/huddle/state/ledger.js';
import { huddleLedgerFixture, runningHuddleInvocation } from '../../helpers/huddle/ledger.js';

function owner(f: ReturnType<typeof huddleLedgerFixture>): RuntimeIdentity {
  return {
    runtime_id: f.identity.runtimeId,
    incarnation: randomUUID(),
    launch_id: randomUUID(),
    profile_id: f.identity.profileId,
    project_id: f.identity.projectId,
    session_id: f.identity.sessionId,
    canonical_worktree_path: f.home,
  };
}
function request(invocationId: string) {
  return { id: randomUUID(), invocationId, kind: 'ask' as const, target: 'agent', input: 'prompt' };
}
it('persists immutable caller identity with intent and keeps it after consumption, owner loss and settlement', () => {
  const f = huddleLedgerFixture();
  try {
    const { invocation } = runningHuddleInvocation(f);
    const input = request(invocation.id);
    const identity = owner(f),
      original = { ...identity };
    f.ledger.operations.prepare(input, Date.now(), identity);
    identity.incarnation = randomUUID();
    expect(f.ledger.operations.origin(input.id)).toEqual(original);
    expect(() => f.ledger.operations.prepare(input, Date.now(), identity)).toThrow('origin');
    expect(() => f.ledger.operations.prepare(input)).toThrow('origin');
    f.ledger.operations.dispatch(input.id);
    f.reopen();
    f.ledger.recoverOwnerLoss();
    expect(f.ledger.operations.get(input.id)).toMatchObject({ state: 'unknown', consumed: true });
    expect(f.ledger.operations.origin(input.id)).toEqual(original);
    expect(f.ledger.operations.prepare(input, Date.now(), original).duplicate).toBe(true);
    expect(() => f.ledger.operations.dispatch(input.id)).toThrow();
    f.ledger.operations.settle(input.id, 'completed', { answer: 'retained' });
    expect(f.ledger.operations.origin(input.id)).toEqual(original);
    expect(f.ledger.executions.get(invocation.executionId).state).toBe('interrupted');
  } finally {
    f.cleanup();
  }
});
it('refuses another placement and rolls back both intent and provenance when capacity fails', () => {
  const f = huddleLedgerFixture();
  let limited: HuddleLedger | undefined;
  try {
    const { invocation } = runningHuddleInvocation(f);
    const input = request(invocation.id);
    const identity = owner(f);
    const before = f.ledger.usage();
    for (const key of ['runtime_id', 'profile_id', 'project_id', 'session_id'] as const) {
      expect(() =>
        f.ledger.operations.prepare(input, Date.now(), {
          ...identity,
          [key]:
            key.endsWith('id') && ['profile_id', 'project_id'].includes(key)
              ? '1111111111'
              : randomUUID(),
        }),
      ).toThrow('placement');
      expect(f.ledger.usage()).toEqual(before);
    }
    f.ledger.close();
    limited = new HuddleLedger(f.home, f.identity, { records: before.records + 1 });
    expect(() => limited!.operations.prepare(input, Date.now(), identity)).toThrow('capacity');
    expect(limited.usage()).toEqual(before);
    expect(limited.page('operations')).toEqual([]);
    expect(limited.page('operation-origins')).toEqual([]);
  } finally {
    limited?.close();
    f.cleanup();
  }
});
it('does not invent or backfill provenance for a legacy duplicate', () => {
  const f = huddleLedgerFixture();
  try {
    const { invocation } = runningHuddleInvocation(f);
    const input = request(invocation.id);
    f.ledger.operations.prepare(input);
    expect(f.ledger.operations.origin(input.id)).toBeNull();
    expect(f.ledger.operations.prepare(input, Date.now(), owner(f)).duplicate).toBe(true);
    expect(f.ledger.operations.origin(input.id)).toBeNull();
    expect(f.ledger.page('operation-origins')).toEqual([]);
  } finally {
    f.cleanup();
  }
});

it.each(['format', 'execution', 'invocation', 'owner'] as const)(
  'rejects corrupted retained %s instead of treating it as legacy provenance',
  (changed) => {
    const f = huddleLedgerFixture();
    let db: Database.Database | undefined;
    try {
      const { invocation } = runningHuddleInvocation(f);
      const input = request(invocation.id);
      const identity = owner(f);
      f.ledger.operations.prepare(input, Date.now(), identity);
      db = new Database(join(f.home, 'runtimes', f.identity.runtimeId, 'huddle.sqlite'));
      if (changed === 'execution')
        db.prepare("UPDATE records SET parent = ? WHERE collection = 'operation-origins'").run(
          randomUUID(),
        );
      else
        db.prepare("UPDATE records SET body = ? WHERE collection = 'operation-origins'").run(
          JSON.stringify({
            format: changed === 'format' ? 2 : 1,
            invocationId: changed === 'invocation' ? randomUUID() : invocation.id,
            owner: changed === 'owner' ? { ...identity, runtime_id: randomUUID() } : identity,
          }),
        );
      expect(() => f.ledger.operations.origin(input.id)).toThrow();
      expect(f.ledger.operations.get(input.id).consumed).toBe(false);
    } finally {
      db?.close();
      f.cleanup();
    }
  },
);
