import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { HuddleTurnStore } from '../../../src/huddle/operations/turns/store.js';
import { openDatabase } from '../../../src/db/db.js';
import { DATABASE_SCHEMA_VERSION } from '../../../src/db/migrations/index.js';
import { programmeTurnFixture } from '../../helpers/runtime/programme-turns.js';
import { huddleTurnScope } from '../../helpers/huddle/agent-turns.js';
import { writeHistoricalDatabase } from '../../helpers/db/historical.js';
import { HUDDLE_TURN_BINDING_LIMITS } from '../../../src/huddle/operations/turns/limits.js';

function fixture() {
  const f = programmeTurnFixture();
  const scope = huddleTurnScope(f);
  const store = new HuddleTurnStore(f.db);
  const request = { prompt: 'Review the worktree' };
  const bind = (value = scope) => store.bind(value, request, () => true);
  const reserve = (bound = bind()) =>
    bound.caller.reserve(
      f.binding.runtime_id,
      { session_id: f.session.id, segment_id: f.binding.active_segment_id! },
      null,
      0,
    );
  return { ...f, huddle: scope, store, request, bind, admit: reserve };
}

it.each(['execution', 'owner', 'host'] as const)(
  'bounds %s operation identities without evicting replay protection',
  async (kind) => {
    const f = fixture();
    try {
      const store = new HuddleTurnStore(f.db, undefined, {
        ...HUDDLE_TURN_BINDING_LIMITS,
        [kind]: 1,
      });
      const bound = store.bind(f.huddle, f.request, () => true);
      const turn = f.admit(bound);
      f.save(turn);
      bound.acknowledge(bound.observe().receipt!);
      expect(() =>
        f.admit(store.bind({ ...f.huddle, operationId: randomUUID() }, f.request, () => true)),
      ).toThrow('binding retention is full');
      expect(() => f.admit(bound)).toThrow('already has a turn identity');
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM huddle_runtime_turns').get()).toEqual({
        n: 1,
      });
    } finally {
      await f.close();
    }
  },
);

it('allocates distinct ordered turns across programme and huddle callers and retains consumed identities', async () => {
  const f = fixture();
  try {
    expect(f.reserve(1)).toBe(1);
    const bound = f.bind();
    expect(f.admit(bound)).toBe(2);
    expect(f.reserve(2)).toBe(3);
    expect(f.admit(f.bind({ ...f.huddle, operationId: randomUUID() }))).toBe(4);
    expect(() => f.admit(bound)).toThrow('already has a turn identity');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM puddlang_runs').get()).toEqual({ n: 1 });
    expect(() => f.store.bind(f.huddle, { prompt: 'Substituted' }, () => true).observe()).toThrow(
      'matching admitted',
    );
    expect(() => f.bind({ ...f.huddle, invocationId: randomUUID() }).observe()).toThrow(
      'matching admitted',
    );
    expect(() => f.bind({ ...f.huddle, activationId: randomUUID() }).observe()).toThrow(
      'matching admitted',
    );
    expect(() => f.bind({ ...f.huddle, revision: 'b'.repeat(64) }).observe()).toThrow(
      'matching admitted',
    );
  } finally {
    await f.close();
  }
});

it('retains unread huddle outcomes across store replacement and pressure until an exact durable-owner receipt', async () => {
  const f = fixture();
  try {
    const turn = f.admit();
    f.save(turn, 'Keep this reply');
    const first = f.bind().observe();
    expect(first).toMatchObject({
      turn,
      result: { status: 'completed', reply: 'Keep this reply' },
      acknowledged: false,
    });
    expect(first.receipt).toMatch(/^[a-f0-9]{64}$/);
    expect(f.db.prepare('SELECT consumed FROM runtime_turns WHERE turn = ?').get(turn)).toEqual({
      consumed: 0,
    });
    for (let operation = 1; operation <= 140; operation++) {
      const next = f.reserve(operation);
      f.save(next);
      f.operations.consume(f.scope(operation), f.binding.runtime_id, next);
    }
    const reopened = openDatabase(f.paths.dbFile);
    try {
      const replacement = new HuddleTurnStore(reopened).bind(f.huddle, f.request, () => true);
      expect(replacement.observe()).toEqual(first);
      expect(() => replacement.acknowledge('b'.repeat(64))).toThrow('unchanged terminal');
      replacement.acknowledge(first.receipt!);
      expect(replacement.observe().acknowledged).toBe(true);
    } finally {
      reopened.close();
    }
    const next = f.reserve(141);
    f.save(next);
    expect(f.observations.turn(f.binding.runtime_id, turn)).toBeNull();
    expect(f.bind().observe()).toMatchObject({
      receipt: first.receipt,
      acknowledged: true,
      result: null,
    });
    f.bind().acknowledge(first.receipt!);
    expect(() => f.bind().acknowledge('c'.repeat(64))).toThrow('acknowledgement changed');
    expect(() => f.admit()).toThrow('already has a turn identity');
  } finally {
    await f.close();
  }
});

it('allows observation and exact cancellation after Stop without admitting another prompt', async () => {
  const f = fixture();
  try {
    const bound = f.bind();
    const turn = f.admit(bound);
    f.save(turn);
    f.db
      .prepare('INSERT INTO huddle_stop_requests VALUES (?, ?, ?)')
      .run(f.huddle.owner.runtime_id, f.huddle.owner.session_id, new Date().toISOString());
    expect(() => bound.caller.check(f.binding.runtime_id)).toThrow('no longer available');
    expect(() => bound.caller.checkCancellation(f.binding.runtime_id, turn)).not.toThrow();
    expect(() => bound.caller.checkCancellation(f.binding.runtime_id, turn + 1)).toThrow(
      'admitted turn',
    );
    const value = bound.observe();
    bound.acknowledge(value.receipt!);
    const revoked = f.store.bind(f.huddle, f.request, () => false);
    expect(() => revoked.observe()).toThrow('authority expired');
    expect(() => revoked.acknowledge(value.receipt!)).toThrow('authority expired');
  } finally {
    await f.close();
  }
});

it('rejects changed owner/profile/worktree/placement and rolls back capacity if durable mapping fails', async () => {
  const f = fixture();
  try {
    for (const scope of [
      { ...f.huddle, owner: { ...f.huddle.owner, incarnation: randomUUID() } },
      { ...f.huddle, owner: { ...f.huddle.owner, profile_id: 'b'.repeat(10) } },
      { ...f.huddle, target: { ...f.huddle.target, incarnation: randomUUID() } },
      { ...f.huddle, target: { ...f.huddle.target, sessionId: randomUUID() } },
      { ...f.huddle, target: { ...f.huddle.target, worktree: '/wrong-worktree' } },
    ])
      expect(() => f.admit(f.bind(scope))).toThrow('no longer available');
    f.db.exec(
      "CREATE TRIGGER reject_huddle_turn BEFORE INSERT ON huddle_runtime_turns BEGIN SELECT RAISE(ABORT, 'mapping unavailable'); END",
    );
    expect(() => f.admit()).toThrow('mapping unavailable');
    expect(f.db.prepare('SELECT turns, bytes FROM host_result_usage').get()).toEqual({
      turns: 0,
      bytes: 0,
    });
    expect(f.db.prepare('SELECT * FROM huddle_runtime_turns').all()).toEqual([]);
    f.db.exec('DROP TRIGGER reject_huddle_turn');
    const request = { prompt: 'Original' };
    const scope = structuredClone(f.huddle);
    const bound = f.store.bind(scope, request, () => true);
    request.prompt = 'Changed';
    scope.target.worktree = '/changed';
    const turn = f.admit(bound);
    f.save(turn);
    expect(() =>
      f.store.bind(f.huddle, { prompt: 'Original' }, () => true).observe(),
    ).not.toThrow();
  } finally {
    await f.close();
  }
});

it('releases proven unused reservations after revocation while preserving the one-send mapping', async () => {
  const f = fixture();
  try {
    let authority = true;
    const bound = f.store.bind(f.huddle, f.request, () => authority);
    const turn = f.admit(bound);
    authority = false;
    bound.caller.releaseUnused(
      f.binding.runtime_id,
      { session_id: f.session.id, segment_id: f.binding.active_segment_id! },
      null,
      turn,
    );
    expect(f.db.prepare('SELECT turns FROM host_result_usage').get()).toEqual({ turns: 0 });
    expect(() => f.admit()).toThrow('already has a turn identity');
  } finally {
    await f.close();
  }
});

it('matches restored JSON key order and refuses a mismatched retained native turn reference', async () => {
  const f = fixture();
  try {
    const request = {
      prompt: 'Typed reply',
      output_schema: { type: 'object', properties: { done: { type: 'boolean' } } },
    };
    const bound = f.store.bind(f.huddle, request, () => true);
    const turn = f.admit(bound);
    f.save(turn);
    const restored = f.store.bind(
      f.huddle,
      {
        output_schema: { properties: { done: { type: 'boolean' } }, type: 'object' },
        prompt: 'Typed reply',
      },
      () => true,
    );
    expect(restored.observe().receipt).toBe(bound.observe().receipt);
    f.db
      .prepare(
        "UPDATE runtime_turns SET result = json_set(result, '$.expected_ref', 'different-ref') WHERE runtime_id = ? AND turn = ?",
      )
      .run(f.binding.runtime_id, turn);
    expect(() => restored.observe()).toThrow('differs from the admitted');
  } finally {
    await f.close();
  }
});

it('migrates schema 44 without changing programme mappings or retained agent replies', async () => {
  const f = fixture();
  try {
    const turn = f.reserve(1);
    f.save(turn);
    const file = join(f.home, 'before-huddle-turns.sqlite');
    writeHistoricalDatabase(f.db, file, 44);
    const migrated = openDatabase(file);
    try {
      expect(migrated.pragma('user_version', { simple: true })).toBe(DATABASE_SCHEMA_VERSION);
      expect(migrated.prepare('SELECT * FROM huddle_runtime_turns').all()).toEqual([]);
      for (const table of ['puddlang_runtime_turns', 'runtime_turns', 'runtime_result_charges'])
        expect(migrated.prepare(`SELECT * FROM ${table}`).all()).toEqual(
          f.db.prepare(`SELECT * FROM ${table}`).all(),
        );
    } finally {
      migrated.close();
    }
  } finally {
    await f.close();
  }
});
