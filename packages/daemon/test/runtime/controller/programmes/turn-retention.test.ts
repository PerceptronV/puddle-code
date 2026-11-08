import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RUNTIME_LIMITS } from '@puddle/shared';
import { openDatabase } from '../../../../src/db/db.js';
import { RuntimeObservationStore } from '../../../../src/db/stores/runtime-observations.js';
import { programmeTurnFixture as fixture } from '../../../helpers/runtime/programme-turns.js';
import { writeHistoricalDatabase } from '../../../helpers/db/historical.js';

it('serves hundreds of turns while retaining unread outcomes and rejecting reclaimed identities', async () => {
  const f = fixture();
  try {
    for (let turn = 1; turn <= 300; turn++) {
      expect(f.reserve(turn)).toBe(turn);
      f.save(turn);
      if (turn > 1) expect(f.consume(turn)?.reply).toBe(`reply-${turn}`);
    }
    expect(f.observations.turn(f.binding.runtime_id, 1)?.reply).toBe('reply-1');
    expect(f.observations.turn(f.binding.runtime_id, 2)).toBeNull();
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM runtime_turns').get()).toEqual({
      count: 128,
    });
    expect(() =>
      f.observations.saveTurn(f.binding, {
        turn: 2,
        expected_ref: null,
        status: 'running',
      }),
    ).toThrow('ordered admission');
    expect(() => f.reserve(2)).toThrow('already has a turn identity');
    // Identity allocation survives removal of old programme mappings too.
    f.db.prepare('DELETE FROM puddlang_runtime_turns WHERE run_id = ?').run(f.run.id);
    expect(f.reserve(301)).toBe(301);
  } finally {
    await f.close();
  }
});

it('reserves escaped result bytes before dispatch and rolls back reclamation on a failed intent', async () => {
  const f = fixture();
  try {
    const reply = '\u0000'.repeat(RUNTIME_LIMITS.turnReplyBytes);
    for (let turn = 1; turn <= 10; turn++) {
      f.reserve(turn);
      f.save(turn, reply);
      f.consume(turn);
    }
    f.db.exec(
      "CREATE TRIGGER reject_intent BEFORE INSERT ON puddlang_runtime_turns BEGIN SELECT RAISE(ABORT, 'cannot save intent'); END",
    );
    expect(() => f.reserve(11)).toThrow('cannot save intent');
    expect(f.observations.turn(f.binding.runtime_id, 1)?.reply).toBe(reply);
    f.db.exec('DROP TRIGGER reject_intent');
    expect(f.reserve(11)).toBe(11);
    expect(f.observations.turn(f.binding.runtime_id, 1)).toBeNull();
    f.save(11, reply);
    expect(f.observations.turn(f.binding.runtime_id, 11)?.reply).toBe(reply);
    expect(
      f.db.prepare('SELECT SUM(bytes) <= 16777216 AS bounded FROM runtime_turns').get(),
    ).toEqual({ bounded: 1 });
  } finally {
    await f.close();
  }
});

it('keeps turn allocation monotonic when pressure reclaims the newest outcome', async () => {
  const f = fixture();
  try {
    for (let turn = 1; turn < 128; turn++) f.save(turn);
    expect(f.reserve(128)).toBe(128);
    f.save(128);
    f.consume(128);
    f.db.prepare('DELETE FROM puddlang_runtime_turns WHERE run_id = ?').run(f.run.id);
    // All older outcomes are unread: only the newest one can yield space.
    expect(f.reserve(129)).toBe(129);
    expect(f.observations.turn(f.binding.runtime_id, 128)).toBeNull();
    expect(() => f.save(128)).toThrow('ordered admission');
    f.save(129);
  } finally {
    await f.close();
  }
});

it('keeps unread or running results protected and checks exact programme authority before consumption', async () => {
  const f = fixture();
  try {
    f.reserve(1);
    f.observations.saveTurn(f.binding, { turn: 1, expected_ref: null, status: 'running' });
    expect(f.consume(1)?.status).toBe('running');
    expect(f.db.prepare('SELECT consumed FROM runtime_turns').get()).toEqual({ consumed: 0 });
    f.observations.saveTurn(f.binding, {
      turn: 1,
      expected_ref: null,
      status: 'failed',
      error: 'failure',
    });
    expect(() =>
      f.operations.consume({ ...f.scope(1), profileId: 'other' }, f.binding.runtime_id, 1),
    ).toThrow();
    expect(() => f.operations.consume(f.scope(2), f.binding.runtime_id, 1)).toThrow('binding');
    f.runs.finish(f.run.id, 'interrupted');
    expect(() => f.consume(1)).toThrow();
    expect(f.db.prepare('SELECT consumed FROM runtime_turns').get()).toEqual({ consumed: 0 });
    for (let turn = 2; turn <= 128; turn++) f.save(turn);
    expect(() => f.observations.reserveTurnCapacity(f.binding.runtime_id)).toThrow(
      'retention is full',
    );
    expect(f.observations.turn(f.binding.runtime_id, 1)?.error).toBe('failure');
  } finally {
    await f.close();
  }
});

it('rolls back result reclamation and its watermark when the replacement observation cannot commit', async () => {
  const f = fixture();
  try {
    for (let turn = 1; turn <= 128; turn++) {
      f.reserve(turn);
      f.save(turn);
      f.consume(turn);
    }
    f.db.exec(
      "CREATE TRIGGER reject_watermark BEFORE INSERT ON runtime_turn_watermarks BEGIN SELECT RAISE(ABORT, 'cannot save watermark'); END",
    );
    expect(() => f.save(129)).toThrow('cannot save watermark');
    expect(f.observations.turn(f.binding.runtime_id, 1)?.reply).toBe('reply-1');
    expect(f.observations.turn(f.binding.runtime_id, 129)).toBeNull();
    expect(f.db.prepare('SELECT turn FROM runtime_turn_watermarks').get()).toEqual({ turn: 128 });
  } finally {
    await f.close();
  }
});

it('upgrades existing private results conservatively and restores their monotonic watermark', async () => {
  const f = fixture();
  f.save(41);
  const historical = join(f.home, 'schema36.sqlite');
  writeHistoricalDatabase(f.db, historical, 36);
  await f.close();
  const db = openDatabase(historical);
  try {
    expect(db.prepare('SELECT consumed FROM runtime_turns').get()).toEqual({ consumed: 0 });
    expect(db.prepare('SELECT turn FROM runtime_turn_watermarks').get()).toEqual({ turn: 41 });
    const observations = new RuntimeObservationStore(db);
    expect(observations.turn(f.binding.runtime_id, 41)?.reply).toBe('reply-41');
    expect(() =>
      observations.saveTurn(f.binding, { turn: 40, expected_ref: null, status: 'running' }),
    ).toThrow('ordered admission');
  } finally {
    db.close();
  }
});
