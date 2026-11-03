import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { RuntimeEventPage, RuntimeRetainedEvent, RuntimeTerminal } from '@puddle/shared';
import { runtimeDatabase } from '../helpers/runtime-database.js';

const terminal = (): RuntimeTerminal => ({
  term: 'agent',
  generation: randomUUID(),
  pid: 42,
  exit_code: null,
  cols: 80,
  rows: 24,
});
function page(events: RuntimeRetainedEvent[]): RuntimeEventPage {
  const through = events.at(-1)?.cursor ?? 0;
  return {
    events,
    through,
    more: false,
    gap: false,
    journal: { cursor: through, acknowledged: 0, lost_through: 0, persistence_pending: false },
  };
}

it('atomically recovers native switches, environment and private turns without replaying effects', async () => {
  const f = runtimeDatabase('interactive');
  try {
    const main = terminal();
    const shell = { ...terminal(), term: 'shell-1', pid: 43 };
    const initial = { id: f.binding.runtime_id, start_cursor: 0, agent_session_ref: 'first' };
    const next = { id: randomUUID(), start_cursor: 6, agent_session_ref: 'second' };
    const replay = page([
      { t: 'terminal-created', cursor: 1, terminal: main },
      {
        t: 'env-delta',
        cursor: 2,
        term: main.term,
        generation: main.generation,
        delta: { op: 'set', name: 'PRIVATE_VALUE', value: 'before-switch' },
      },
      {
        t: 'native-lifecycle',
        cursor: 3,
        segment: initial,
        previous_segment_id: null,
        lifecycle: {
          event: 'session_start',
          agent_session_ref: 'first',
          cwd: f.home,
          source: 'startup',
        },
      },
      { t: 'turn-started', cursor: 4, turn: { turn: 1, expected_ref: 'first', status: 'running' } },
      {
        t: 'turn-finished',
        cursor: 5,
        result: {
          turn: 1,
          expected_ref: 'first',
          status: 'completed',
          reply: 'private-provider-reply',
        },
      },
      {
        t: 'native-lifecycle',
        cursor: 6,
        segment: next,
        previous_segment_id: initial.id,
        lifecycle: {
          event: 'session_start',
          agent_session_ref: 'second',
          cwd: f.home,
          source: 'fork',
        },
      },
      {
        t: 'env-delta',
        cursor: 7,
        term: main.term,
        generation: main.generation,
        delta: { op: 'set', name: 'PRIVATE_VALUE', value: 'after-switch' },
      },
      { t: 'capture-env', cursor: 8, enabled: false },
      { t: 'clear-env', cursor: 9 },
      { t: 'terminal-created', cursor: 10, terminal: shell },
      { t: 'exit', cursor: 11, term: shell.term, generation: shell.generation, exit_code: 0 },
      {
        t: 'native-lifecycle',
        cursor: 12,
        segment: next,
        previous_segment_id: null,
        lifecycle: {
          event: 'session_end',
          agent_session_ref: 'second',
          cwd: f.home,
          source: 'exit',
        },
      },
    ]);
    const switched = vi.fn();
    f.reconciler.on('session-switched', switched);
    // A lifecycle observation alone cannot prove installed-version support.
    f.sessions.setNativeSync(f.session.id, 'fallback');
    f.sessions.mergeEnv(f.session.id, { BEFORE_TRANSACTION: 'unchanged' }, []);
    f.db.exec(
      "CREATE TRIGGER fail_switch BEFORE INSERT ON events WHEN NEW.type = 'native_switched_to' BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END",
    );
    expect(() => f.reconciler.applyPage(f.binding.runtime_id, replay)).toThrow(
      'fixture storage failure',
    );
    expect(f.runtimes.get(f.binding.runtime_id)).toEqual(f.binding);
    expect(f.conversations.list()).toEqual([]);
    expect(f.sessions.list()).toHaveLength(1);
    expect(f.sessions.getEnv(f.session.id)).toEqual({ BEFORE_TRANSACTION: 'unchanged' });
    expect(f.reconciler.observations.get(f.binding.runtime_id)).toBeNull();
    expect(f.reconciler.observations.turn(f.binding.runtime_id, 1)).toBeNull();
    expect(switched).not.toHaveBeenCalled();
    f.db.exec('DROP TRIGGER fail_switch');
    f.reconciler.applyPage(f.binding.runtime_id, replay);
    const current = f.runtimes.get(f.binding.runtime_id)!;
    expect(current).toMatchObject({ event_cursor: 12, active_segment_id: next.id });
    expect(f.sessions.get(current.active_session_id)).toMatchObject({
      agent_session_ref: 'second',
      parent_conversation_id: f.sessions.get(f.session.id).conversation_id,
      branch_owner: true,
      native_sync: 'fallback',
    });
    expect(f.sessions.get(f.session.id)).toMatchObject({
      status: 'exited',
      branch_owner: false,
      native_sync: 'fallback',
    });
    expect(f.sessions.getEnv(f.session.id)).toEqual({
      INITIAL: 'seed',
      PRIVATE_VALUE: 'before-switch',
    });
    expect(f.sessions.getEnv(current.active_session_id)).toEqual({});
    expect(f.reconciler.observations.get(current.runtime_id)).toEqual({
      captureEnabled: false,
      terminals: [main, { ...shell, pid: null, exit_code: 0 }],
    });
    expect(f.reconciler.observations.turn(current.runtime_id, 1)).toMatchObject({
      reply: 'private-provider-reply',
    });
    const audit = [...f.events.list(f.session.id), ...f.events.list(current.active_session_id)];
    expect(JSON.stringify(audit)).not.toMatch(
      /private-provider-reply|PRIVATE_VALUE|before-switch|after-switch/,
    );
    f.reconciler.applyPage(current.runtime_id, replay);
    expect(f.sessions.list()).toHaveLength(2);
    expect([...f.events.list(f.session.id), ...f.events.list(current.active_session_id)]).toEqual(
      audit,
    );
    expect(switched).toHaveBeenCalledTimes(1);
  } finally {
    await f.reconciler.close();
    f.db.close();
  }
});

it('rejects missing history, denied environment names and stale terminal generations without advancing', async () => {
  const f = runtimeDatabase();
  try {
    const main = terminal();
    const first: RuntimeRetainedEvent = { t: 'terminal-created', cursor: 1, terminal: main };
    expect(() =>
      f.reconciler.applyPage(f.binding.runtime_id, { ...page([first]), gap: true }),
    ).toThrow(/incomplete/);
    expect(() => f.reconciler.applyPage(f.binding.runtime_id, page([first, first]))).toThrow(
      /order/,
    );
    expect(() =>
      f.reconciler.applyPage(
        f.binding.runtime_id,
        page([
          first,
          {
            t: 'env-delta',
            cursor: 2,
            term: 'agent',
            generation: main.generation,
            delta: { op: 'set', name: 'PUDDLE_AGENT_SIGNAL_NONCE', value: 'forbidden' },
          },
        ]),
      ),
    ).toThrow(/inadmissible/);
    expect(() =>
      f.reconciler.applyPage(
        f.binding.runtime_id,
        page([
          first,
          { t: 'exit', cursor: 2, term: 'agent', generation: randomUUID(), exit_code: 0 },
        ]),
      ),
    ).toThrow(/generation/);
    expect(f.runtimes.get(f.binding.runtime_id)).toEqual(f.binding);
    expect(f.reconciler.observations.get(f.binding.runtime_id)).toBeNull();
    f.reconciler.applyPage(f.binding.runtime_id, page([first]));
    expect(() =>
      f.reconciler.applyPage(f.binding.runtime_id, {
        ...page([]),
        through: 2,
        journal: { cursor: 2, acknowledged: 2, lost_through: 0, persistence_pending: false },
      }),
    ).toThrow(/committed/);
    expect(f.runtimes.get(f.binding.runtime_id)?.event_cursor).toBe(1);
  } finally {
    await f.reconciler.close();
    f.db.close();
  }
});

it('bounds private turn retention and refuses to acknowledge outcomes it cannot retain', async () => {
  const f = runtimeDatabase('headless');
  try {
    const events: RuntimeRetainedEvent[] = [
      { t: 'terminal-created', cursor: 1, terminal: terminal() },
    ];
    for (let turn = 1; turn <= 128; turn++)
      events.push(
        {
          t: 'turn-started',
          cursor: 2 * turn,
          turn: { turn, expected_ref: null, status: 'running' },
        },
        {
          t: 'turn-finished',
          cursor: 2 * turn + 1,
          result: { turn, expected_ref: null, status: 'completed', reply: `result-${turn}` },
        },
      );
    f.reconciler.applyPage(f.binding.runtime_id, page(events.slice(0, 255)));
    f.reconciler.applyPage(f.binding.runtime_id, page(events.slice(255)));
    expect(() =>
      f.reconciler.applyPage(
        f.binding.runtime_id,
        page([
          {
            t: 'turn-started',
            cursor: 258,
            turn: { turn: 129, expected_ref: null, status: 'running' },
          },
        ]),
      ),
    ).toThrow(/retention is full/);
    expect(f.runtimes.get(f.binding.runtime_id)?.event_cursor).toBe(257);
    expect(f.reconciler.observations.turn(f.binding.runtime_id, 128)).toMatchObject({
      reply: 'result-128',
    });
    expect(f.reconciler.observations.turn(f.binding.runtime_id, 129)).toBeNull();
  } finally {
    await f.reconciler.close();
    f.db.close();
  }
});
