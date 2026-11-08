import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { RUNTIME_PROTOCOL_VERSION } from '@puddle/shared';
import { openDatabase, type Db } from '../../../../src/db/db.js';
import { RuntimeObservationStore } from '../../../../src/db/stores/runtime-observations.js';
import { ProgrammeTurnStore } from '../../../../src/puddlang/runtime-turn-store.js';
import { ProgrammeOutcomeStore } from '../../../../src/puddlang/outcomes/store.js';
import {
  RESULT_RESERVATION_BYTES as reservation,
  RUNTIME_RESULT_LIMITS,
} from '../../../../src/db/stores/runtime-results/limits.js';
import { RESULT_RECLAIM_CANDIDATES } from '../../../../src/db/stores/runtime-results/capacity.js';
import { programmeTurnFixture } from '../../../helpers/runtime/programme-turns.js';
import { dropResultCapacity } from '../../../helpers/runtime/result-capacity.js';
import { writeHistoricalDatabase } from '../../../helpers/db/historical.js';
import { bundleDir, children } from '../../../helpers/runtime-fixture.js';

const usage = (db: Db) => db.prepare('SELECT turns, bytes FROM host_result_usage').get();
function fixture(turns = 3, bytes = 3 * reservation) {
  const f = programmeTurnFixture();
  const limits = { runtime: RUNTIME_RESULT_LIMITS, host: { turns, bytes } };
  const operations = new ProgrammeTurnStore(f.db, limits);
  const observations = new RuntimeObservationStore(f.db, limits);
  const another = () => {
    const session = f.sessions.create({ ...f.session, id: randomUUID() });
    const binding = f.runtimes.prepare({
      identity: {
        ...f.launch.identity,
        runtime_id: randomUUID(),
        incarnation: randomUUID(),
        launch_id: randomUUID(),
        session_id: session.id,
      },
      build: 'fixture',
      protocol: RUNTIME_PROTOCOL_VERSION,
      releasePath: f.directory,
    });
    f.db
      .prepare("UPDATE runtime_bindings SET state = 'running' WHERE runtime_id = ?")
      .run(binding.runtime_id);
    return binding;
  };
  const reserve = (operation: number, binding = f.binding, store = operations) =>
    store.reserve(
      f.scope(operation),
      binding.runtime_id,
      { session_id: binding.active_session_id, segment_id: binding.active_segment_id! },
      null,
      0,
    );
  const save = (turn: number, reply: string, binding = f.binding, store = observations) => {
    store.saveTurn(binding, { turn, status: 'running', expected_ref: null });
    store.saveTurn(binding, { turn, status: 'completed', expected_ref: null, reply });
  };
  return { ...f, limits, operations, observations, another, reserve, save };
}

it('charges pending admissions across owners and releases each reservation exactly once to encoded bytes', async () => {
  const f = fixture(2, 2 * reservation);
  try {
    const other = f.another();
    expect(usage(f.db)).toEqual({ turns: 0, bytes: 0 }); // Launch intent is not a headless ask.
    f.reserve(1);
    f.reserve(2, other);
    expect(usage(f.db)).toEqual({ turns: 2, bytes: 2 * reservation });
    expect(() => f.reserve(3)).toThrow('retention is full');
    const reply = '😄\u0000\n\\"';
    f.save(1, reply);
    const result = f.observations.turn(f.binding.runtime_id, 1)!;
    const encoded = Buffer.byteLength(JSON.stringify(result));
    expect(usage(f.db)).toEqual({ turns: 2, bytes: reservation + encoded });
    expect(() => f.observations.saveTurn(f.binding, result)).toThrow('immutable');
    expect(usage(f.db)).toEqual({ turns: 2, bytes: reservation + encoded });
  } finally {
    await f.close();
  }
});

it('shares reservations between independent SQLite writers and retains them after an unobserved dispatch/reopen', async () => {
  const f = fixture(1, reservation);
  const other = f.another();
  const second = openDatabase(f.paths.dbFile);
  second.pragma('busy_timeout = 0');
  try {
    const competing = new ProgrammeTurnStore(second, f.limits);
    f.db.transaction(() => {
      f.reserve(1);
      expect(() => f.reserve(2, other, competing)).toThrow(/locked/);
    })();
    expect(() => f.reserve(2, other, competing)).toThrow('retention is full');
    expect(second.prepare('SELECT COUNT(*) AS n FROM puddlang_runtime_turns').get()).toEqual({
      n: 1,
    });
  } finally {
    second.close();
    await f.close();
  }
  const reopened = openDatabase(f.paths.dbFile);
  try {
    expect(usage(reopened)).toEqual({ turns: 1, bytes: reservation });
    const observations = new RuntimeObservationStore(reopened, f.limits);
    f.save(1, 'completed after outage', f.binding, observations);
    const result = observations.turn(f.binding.runtime_id, 1)!;
    expect(usage(reopened)).toEqual({ turns: 1, bytes: Buffer.byteLength(JSON.stringify(result)) });
    expect(() => f.reserve(2, other, new ProgrammeTurnStore(reopened, f.limits))).toThrow(
      'retention is full',
    );
  } finally {
    reopened.close();
  }
});

it('reclaims only explicitly disposed terminal payloads across owners while preserving audit and monotonic identities', async () => {
  const f = fixture(1);
  try {
    f.reserve(1);
    f.save(1, 'private result');
    f.runs.finish(f.run.id, 'interrupted');
    const audit = new ProgrammeOutcomeStore(f.db, () => {});
    const prior = audit.list(f.profile.id, f.run.id).outcomes[0]!;
    const request = { action: 'discard' as const, fingerprint: prior.fingerprint! };
    audit.dispose(f.profile.id, f.run.id, 1, request, () => true);
    const other = f.another();
    // A new observation uses the same admission budget without another programme mapping.
    f.observations.saveTurn(other, { turn: 1, status: 'running', expected_ref: null });
    expect(f.observations.turn(f.binding.runtime_id, 1)).toBeNull();
    expect(audit.dispose(f.profile.id, f.run.id, 1, request, () => true)).toMatchObject({
      outcome: { retained: false, consumed: true, disposition: request },
      result: null,
    });
    expect(
      f.db
        .prepare('SELECT turn FROM runtime_turn_watermarks WHERE runtime_id = ?')
        .get(f.binding.runtime_id),
    ).toEqual({ turn: 1 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM puddlang_runtime_turns').get()).toEqual({
      n: 1,
    });
    expect(() =>
      f.observations.saveTurn(f.binding, { turn: 1, status: 'running', expected_ref: null }),
    ).toThrow('ordered admission');
  } finally {
    await f.close();
  }
});

it('does not reclaim consumed running, unknown or unread records under host pressure', async () => {
  const f = fixture(3);
  try {
    const second = f.another();
    const third = f.another();
    f.reserve(1);
    f.reserve(2, second);
    f.reserve(3, third);
    f.observations.saveTurn(second, { turn: 1, status: 'running', expected_ref: null });
    f.db
      .prepare('UPDATE runtime_turns SET consumed = 1 WHERE runtime_id = ?')
      .run(second.runtime_id);
    f.save(1, 'unread', third);
    expect(() => f.reserve(4)).toThrow('retention is full');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM runtime_result_charges').get()).toEqual({
      n: 3,
    });
    expect(f.observations.turn(third.runtime_id, 1)?.reply).toBe('unread');
  } finally {
    await f.close();
  }
});

it('rolls back cross-owner reclamation, counters and reservation when intent cannot commit', async () => {
  const f = fixture(1);
  try {
    f.reserve(1);
    f.save(1, 'keep until commit');
    f.operations.consume(f.scope(1), f.binding.runtime_id, 1);
    const before = usage(f.db);
    const other = f.another();
    f.db.exec(
      "CREATE TRIGGER fail_capacity_intent BEFORE INSERT ON puddlang_runtime_turns BEGIN SELECT RAISE(ABORT, 'intent failed'); END",
    );
    expect(() => f.reserve(2, other)).toThrow('intent failed');
    expect(usage(f.db)).toEqual(before);
    expect(f.observations.turn(f.binding.runtime_id, 1)?.reply).toBe('keep until commit');
    f.db.exec('DROP TRIGGER fail_capacity_intent');
    expect(f.reserve(2, other)).toBe(1);
    expect(usage(f.db)).toEqual({ turns: 1, bytes: reservation });
  } finally {
    await f.close();
  }
});

it('migrates only above-watermark unknown reservations and permits reserved completion above the new budget', async () => {
  // Migration041 freezes this runtime-1.0 reservation. A future policy change
  // needs a new migration, rather than silently altering historical accounting.
  expect(reservation).toBe(1605632);
  const f = fixture(1, reservation);
  f.reserve(1);
  f.save(1, 'historical disposed');
  f.operations.consume(f.scope(1), f.binding.runtime_id, 1);
  f.db.prepare('DELETE FROM runtime_turns').run();
  const other = f.another();
  // Build genuine old-schema pending mapping evidence, without using new capacity checks.
  dropResultCapacity(f.db);
  f.db
    .prepare(`INSERT INTO puddlang_runtime_turns VALUES (?, 2, ?, 2, ?, ?, NULL)`)
    .run(f.run.id, f.binding.runtime_id, f.binding.active_session_id, f.binding.active_segment_id);
  f.db
    .prepare(`INSERT INTO puddlang_runtime_turns VALUES (?, 3, ?, 1, ?, ?, NULL)`)
    .run(f.run.id, other.runtime_id, other.active_session_id, other.active_segment_id);
  const historical = join(f.home, 'schema40.sqlite');
  writeHistoricalDatabase(f.db, historical, 40);
  await f.close();
  const db = openDatabase(historical);
  try {
    expect(usage(db)).toEqual({ turns: 2, bytes: 2 * reservation });
    expect(db.prepare('SELECT * FROM puddlang_outcome_dispositions').all()).toEqual([]);
    const observations = new RuntimeObservationStore(db, f.limits);
    f.save(2, 'late completion', f.binding, observations);
    expect(observations.turn(f.binding.runtime_id, 1)).toBeNull();
    expect(observations.turn(f.binding.runtime_id, 2)?.reply).toBe('late completion');
    expect(() =>
      new ProgrammeTurnStore(db, f.limits).reserve(
        f.scope(4),
        other.runtime_id,
        { session_id: other.active_session_id, segment_id: other.active_segment_id! },
        null,
        0,
      ),
    ).toThrow('retention is full');
  } finally {
    db.close();
  }
});

it('updates aggregate counters once when payloads or their runtime binding cascade away', async () => {
  const f = fixture();
  try {
    f.reserve(1);
    const other = f.another();
    f.observations.reserveTurnCapacity(other.runtime_id, 1);
    f.observations.saveTurn(other, { turn: 1, status: 'running', expected_ref: null });
    expect(usage(f.db)).toEqual({ turns: 2, bytes: 2 * reservation });
    f.db.prepare('DELETE FROM runtime_bindings WHERE runtime_id = ?').run(other.runtime_id);
    expect(usage(f.db)).toEqual({ turns: 1, bytes: reservation });
    expect(
      f.db.prepare('SELECT * FROM runtime_result_usage WHERE runtime_id = ?').all(other.runtime_id),
    ).toEqual([]);
    f.save(1, 'result');
    f.db.prepare('DELETE FROM runtime_turns WHERE runtime_id = ?').run(f.binding.runtime_id);
    expect(usage(f.db)).toEqual({ turns: 0, bytes: 0 });
    expect(f.db.prepare('SELECT turns, bytes FROM runtime_result_usage').get()).toEqual({
      turns: 0,
      bytes: 0,
    });
  } finally {
    await f.close();
  }
});

it('commits bounded reclamation progress through more than one pass of migrated disposable debt', async () => {
  const f = fixture(3);
  try {
    // Isolated historical rows deliberately exceed the current admission cap.
    for (let turn = 1; turn <= 2 * RESULT_RECLAIM_CANDIDATES + 2; turn++) {
      const result = JSON.stringify({
        turn,
        status: 'completed',
        expected_ref: null,
        reply: 'retained',
      });
      f.db
        .prepare('INSERT INTO runtime_turns VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(
          f.binding.runtime_id,
          turn,
          f.session.id,
          f.binding.active_segment_id,
          result,
          Buffer.byteLength(result),
          turn === 1 ? 0 : 1,
        );
    }
    const other = f.another();
    expect(() => f.reserve(1, other)).toThrow('retention is full');
    const before = usage(f.db);
    f.db.exec(`CREATE TRIGGER fail_reclaim_batch BEFORE DELETE ON runtime_turns
      WHEN (SELECT turns FROM host_result_usage) < ${2 * RESULT_RECLAIM_CANDIDATES + 2}
      BEGIN SELECT RAISE(ABORT, 'batch failed'); END`);
    expect(() => f.observations.reclaimResults()).toThrow('batch failed');
    expect(usage(f.db)).toEqual(before);
    f.db.exec('DROP TRIGGER fail_reclaim_batch');
    expect(f.observations.reclaimResults()).toBe(true);
    expect(f.db.prepare('SELECT turns FROM host_result_usage').get()).toEqual({
      turns: RESULT_RECLAIM_CANDIDATES + 2,
    });
    expect(f.observations.reclaimResults()).toBe(false);
    expect(f.db.prepare('SELECT turns FROM host_result_usage').get()).toEqual({ turns: 2 });
    expect(f.observations.turn(f.binding.runtime_id, 1)?.reply).toBe('retained');
    expect(f.reserve(1, other)).toBe(1);
  } finally {
    await f.close();
  }
});

it('continues final-journal retirement debt in bounded batches without deleting retained outcomes', async () => {
  const f = fixture();
  try {
    f.save(1, 'unread');
    for (let turn = 2; turn <= 2 * RESULT_RECLAIM_CANDIDATES + 2; turn++)
      f.db
        .prepare('INSERT INTO runtime_result_charges VALUES (?, ?, ?)')
        .run(f.binding.runtime_id, turn, reservation);
    f.db.transaction(() => f.observations.retireResults(f.binding.runtime_id))();
    expect(f.db.prepare('SELECT turns FROM host_result_usage').get()).toEqual({
      turns: RESULT_RECLAIM_CANDIDATES + 2,
    });
    expect(f.observations.reclaimResults()).toBe(true);
    expect(f.observations.reclaimResults()).toBe(false);
    expect(f.db.prepare('SELECT turns FROM host_result_usage').get()).toEqual({ turns: 1 });
    expect(f.observations.turn(f.binding.runtime_id, 1)?.reply).toBe('unread');
    expect(() =>
      f.observations.saveTurn(f.binding, { turn: 1000, status: 'running', expected_ref: null }),
    ).toThrow('retired');
  } finally {
    await f.close();
  }
});

it('releases unused debt only for the exact original mapping, independently of programme liveness', async () => {
  const f = fixture();
  try {
    f.reserve(1);
    f.runs.finish(f.run.id, 'cancelled');
    const placement = {
      session_id: f.binding.active_session_id,
      segment_id: f.binding.active_segment_id!,
    };
    for (const wrong of [
      () =>
        f.operations.releaseUnused(
          { ...f.scope(1), profileId: 'wrong' },
          f.binding.runtime_id,
          placement,
          null,
          1,
        ),
      () =>
        f.operations.releaseUnused(
          f.scope(1),
          f.binding.runtime_id,
          { ...placement, segment_id: randomUUID() },
          null,
          1,
        ),
      () => f.operations.releaseUnused(f.scope(1), f.binding.runtime_id, placement, 'wrong', 1),
    ])
      expect(wrong).toThrow('no longer matches');
    expect(usage(f.db)).toEqual({ turns: 1, bytes: reservation });
    f.operations.releaseUnused(f.scope(1), f.binding.runtime_id, placement, null, 1);
    expect(usage(f.db)).toEqual({ turns: 0, bytes: 0 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM puddlang_runtime_turns').get()).toEqual({
      n: 1,
    });
    expect(f.db.prepare('SELECT * FROM puddlang_outcome_dispositions').all()).toEqual([]);
  } finally {
    await f.close();
  }
});

it('uses bounded indexed candidates and rolls back a pass that cannot recover enough space', async () => {
  const f = fixture(1);
  try {
    // Historical debt may exceed today's per-owner bound. These rows are all
    // explicitly consumed; the bounded host pass still cannot scan all of them.
    for (let turn = 1; turn <= RESULT_RECLAIM_CANDIDATES + 1; turn++) {
      const result = JSON.stringify({ turn, status: 'completed', expected_ref: null, reply: 'x' });
      f.db
        .prepare('INSERT INTO runtime_turns VALUES (?, ?, ?, ?, ?, ?, 1)')
        .run(
          f.binding.runtime_id,
          turn,
          f.session.id,
          f.binding.active_segment_id,
          result,
          Buffer.byteLength(result),
        );
    }
    const other = f.another();
    const before = usage(f.db);
    expect(() => f.reserve(1, other)).toThrow('retention is full');
    expect(usage(f.db)).toEqual(before);
    const query = f.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT runtime_id, turn FROM runtime_turns INDEXED BY runtime_result_reclaim_host
      WHERE consumed = 1 AND json_extract(result, '$.status') IN ('completed', 'failed', 'cancelled', 'interrupted')
      ORDER BY bytes DESC, runtime_id, turn LIMIT 256`,
      )
      .all();
    expect(JSON.stringify(query)).toContain('runtime_result_reclaim_host');
    expect(JSON.stringify(query)).not.toContain('TEMP B-TREE');
  } finally {
    await f.close();
  }
});

it('releases only absent older reservations once a newer immutable admission commits', async () => {
  const f = fixture(3);
  try {
    f.reserve(1); // A lost admission reply leaves no observation or disposition.
    f.reserve(2);
    f.db.exec(
      "CREATE TRIGGER fail_capacity_result BEFORE INSERT ON runtime_turns BEGIN SELECT RAISE(ABORT, 'result failed'); END",
    );
    expect(() =>
      f.observations.saveTurn(f.binding, { turn: 2, status: 'running', expected_ref: null }),
    ).toThrow('result failed');
    expect(usage(f.db)).toEqual({ turns: 2, bytes: 2 * reservation });
    expect(f.db.prepare('SELECT * FROM runtime_turn_watermarks').all()).toEqual([]);
    f.db.exec('DROP TRIGGER fail_capacity_result');
    f.observations.saveTurn(f.binding, { turn: 2, status: 'running', expected_ref: null });
    expect(usage(f.db)).toEqual({ turns: 1, bytes: reservation });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM puddlang_runtime_turns').get()).toEqual({
      n: 2,
    });
    expect(f.db.prepare('SELECT * FROM puddlang_outcome_dispositions').all()).toEqual([]);
    expect(() =>
      f.observations.saveTurn(f.binding, { turn: 1, status: 'running', expected_ref: null }),
    ).toThrow('ordered admission');
  } finally {
    await f.close();
  }
});

it.each(['committed', 'uncommitted'] as const)(
  'recovers %s reservation accounting after abrupt writer death',
  async (mode) => {
    const f = fixture();
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const worker = join(bundleDir, `result-capacity-${mode}.cjs`);
    await build({
      stdin: {
        contents: `
      import { openDatabase } from './src/db/db.ts';
      import { ProgrammeTurnStore } from './src/puddlang/runtime-turn-store.ts';
      const [file, mode, raw] = process.argv.slice(2);
      const input = JSON.parse(raw);
      const db = openDatabase(file);
      if (mode === 'uncommitted') db.exec('BEGIN IMMEDIATE');
      new ProgrammeTurnStore(db).reserve(input.scope, input.runtime, input.placement, null, 0);
      process.send('reserved');
      setInterval(() => {}, 1000);
    `,
        resolveDir: root,
        loader: 'ts',
      },
      outfile: worker,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['better-sqlite3'],
      alias: {
        '@puddle/shared': fileURLToPath(
          new URL('../../../../../shared/src/index.ts', import.meta.url),
        ),
      },
    });
    let errors = '';
    const child = spawn(
      process.execPath,
      [
        worker,
        f.paths.dbFile,
        mode,
        JSON.stringify({
          scope: f.scope(1),
          runtime: f.binding.runtime_id,
          placement: {
            session_id: f.binding.active_session_id,
            segment_id: f.binding.active_segment_id,
          },
        }),
      ],
      {
        env: { PATH: dirname(process.execPath), HOME: f.home, PUDDLE_HOME: f.home },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    children.push(child);
    child.stderr!.on('data', (data: Buffer) => {
      errors += data.toString();
    });
    try {
      await Promise.race([
        once(child, 'message').then(([message]) => expect(message).toBe('reserved')),
        once(child, 'exit').then(() => {
          throw new Error(errors || 'Reservation worker exited early');
        }),
      ]);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const reopened = openDatabase(f.paths.dbFile);
      try {
        expect(usage(reopened)).toEqual({
          turns: mode === 'committed' ? 1 : 0,
          bytes: mode === 'committed' ? reservation : 0,
        });
        expect(reopened.prepare('SELECT COUNT(*) AS n FROM puddlang_runtime_turns').get()).toEqual({
          n: mode === 'committed' ? 1 : 0,
        });
      } finally {
        reopened.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      await f.close();
    }
  },
);
