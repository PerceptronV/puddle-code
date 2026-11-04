import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { openDatabase } from '../../src/db/db.js';
import { RuntimeStore } from '../../src/db/stores/runtimes.js';
import { runtimeDatabase } from '../helpers/runtime-database.js';

it('backfills only proven live terminal generations when upgrading older runtime observations', async () => {
  const f = runtimeDatabase('interactive');
  const generation = randomUUID();
  const next = randomUUID();
  f.reconciler.applyPage(f.binding.runtime_id, {
    events: [
      {
        t: 'terminal-created',
        cursor: 1,
        terminal: { term: 'agent', generation, pid: 42, exit_code: null, cols: 80, rows: 24 },
      },
      {
        t: 'terminal-created',
        cursor: 2,
        terminal: { term: 'shell-1', generation, pid: 43, exit_code: null, cols: 80, rows: 24 },
      },
      { t: 'exit', cursor: 3, term: 'shell-1', generation, exit_code: 0 },
      {
        t: 'native-lifecycle',
        cursor: 4,
        segment: { id: f.binding.runtime_id, start_cursor: 0, agent_session_ref: 'first' },
        previous_segment_id: null,
        lifecycle: {
          event: 'session_start',
          agent_session_ref: 'first',
          cwd: f.home,
          source: 'startup',
        },
      },
      {
        t: 'native-lifecycle',
        cursor: 5,
        segment: { id: next, start_cursor: 5, agent_session_ref: 'second' },
        previous_segment_id: f.binding.runtime_id,
        lifecycle: {
          event: 'session_start',
          agent_session_ref: 'second',
          cwd: f.home,
          source: 'clear',
        },
      },
    ],
    through: 5,
    more: false,
    gap: false,
    journal: { cursor: 5, acknowledged: 0, lost_through: 0, persistence_pending: false },
  });
  const current = f.runtimes.get(f.binding.runtime_id)!;
  expect(f.runtimes.terminalForPlacement(f.session.id, 'shell-1')).toMatchObject({ generation });
  f.db.exec(
    'ALTER TABLE runtime_turns DROP COLUMN consumed; DROP TABLE runtime_turn_watermarks; DROP TABLE puddlang_runtime_spawns; DROP TABLE puddlang_stop_requests; DROP TABLE puddlang_runtime_turns; DROP TABLE runtime_code_runs; DROP TABLE runtime_stop_requests; DROP TABLE runtime_segment_terminals; DROP TABLE terminal_placements; PRAGMA user_version = 31',
  );
  await f.reconciler.close();
  f.db.close();
  const db = openDatabase(f.paths.dbFile);
  try {
    const runtimes = new RuntimeStore(db);
    expect(db.prepare('SELECT * FROM runtime_code_runs').all()).toEqual([]);
    expect(runtimes.terminalForPlacement(current.active_session_id, 'agent')).toMatchObject({
      segment_id: next,
      generation,
    });
    expect(runtimes.terminalForPlacement(current.active_session_id, 'shell-1')).toBeNull();
    expect(runtimes.terminalForPlacement(f.session.id, 'agent')).toBeNull();
    expect(runtimes.terminalForPlacement(f.session.id, 'shell-1')).toBeNull();
    expect(runtimes.usesExternalTerminals(current.active_session_id)).toBe(true);
    expect(() => runtimes.useLegacyTerminals(current.active_session_id)).toThrow(/live external/);
    runtimes.interrupt(current.runtime_id, () => {});
    runtimes.useLegacyTerminals(current.active_session_id);
    expect(runtimes.usesExternalTerminals(current.active_session_id)).toBe(false);
    expect(runtimes.terminalForPlacement(current.active_session_id, 'agent')).toBeNull();
    expect(runtimes.segment(current.runtime_id, next)).not.toBeNull();
  } finally {
    db.close();
  }
});
