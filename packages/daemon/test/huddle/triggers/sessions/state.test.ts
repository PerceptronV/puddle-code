import { afterEach, expect, it } from 'vitest';
import { sessionSourceFixture } from '../../../helpers/huddle/session-source.js';

const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture() {
  const f = sessionSourceFixture();
  cleanups.push(f.base.cleanup);
  return f;
}

it('commits a whole page and its cursor atomically, retaining progress across reopen', () => {
  const f = fixture(),
    { base, baseline } = f;
  const source = base.ledger.sessions.list()[0]!;
  const records = [f.record(11), f.record(12)];
  const page = {
    state: 'events' as const,
    cursor: { ...baseline, sequence: 12 },
    head: 12,
    records,
  };
  expect(() =>
    base.ledger.sessions.admit(source, page, { ...base.settings, maxQueuedEvents: 1 }),
  ).toThrow('queue is full');
  expect(base.ledger.page('executions')).toHaveLength(0);
  expect(base.ledger.sessions.list()[0]!.cursor).toEqual(baseline);
  expect(base.ledger.sessions.admit(source, page, base.settings)).toBe(2);
  base.reopen();
  expect(base.ledger.sessions.list()[0]!.cursor).toEqual(page.cursor);
  expect(base.ledger.page('inbox').map((row) => JSON.parse(row.body).event.data)).toEqual(records);
  expect(() => base.ledger.sessions.admit(source, page, base.settings)).toThrow('cursor changed');
  const current = base.ledger.sessions.list()[0]!;
  expect(base.ledger.sessions.admit(current, { ...page, records: [] }, base.settings)).toBe(0);
  expect(base.ledger.page('executions')).toHaveLength(2);
});

it('advances filtered status observations without inventing completions or executions', () => {
  const f = fixture(),
    { base, baseline } = f;
  const records = [
    f.record(11, {
      event: 'status',
      source: 'status',
      previousStatus: 'running',
      status: 'waiting_input',
    }),
    f.record(12, {
      event: 'status',
      source: 'status',
      previousStatus: 'running',
      status: 'exited',
    }),
  ];
  expect(
    base.ledger.sessions.admit(
      base.ledger.sessions.list()[0]!,
      {
        state: 'events',
        cursor: { ...baseline, sequence: 20 },
        head: 20,
        records,
      },
      base.settings,
    ),
  ).toBe(1);
  const event = JSON.parse(base.ledger.page('inbox')[0]!.body).event;
  expect(event.data).toEqual(records[1]);
  expect(event.occurredAt).toBeUndefined();
  expect(event.resource).toEqual({
    kind: 'session',
    sessionId: records[1]!.sessionId,
    worktree: records[1]!.worktree,
  });
  expect(base.ledger.sessions.list()[0]!.cursor.sequence).toBe(20);
});

it('rejects foreign scope, old generations and retention gaps without advancing', () => {
  const f = fixture(),
    { base, baseline } = f;
  const source = base.ledger.sessions.list()[0]!;
  for (const patch of [
    { profileId: '1111111111' },
    { projectId: '2222222222' },
    { worktree: '/foreign' },
    { sessionId: base.identity.sessionId },
    { sessionKind: 'agent' as const },
  ]) {
    expect(() =>
      base.ledger.sessions.admit(
        source,
        {
          state: 'events',
          cursor: { ...baseline, sequence: 11 },
          head: 11,
          records: [f.record(11, patch)],
        },
        base.settings,
      ),
    ).toThrow('declared subscription');
  }
  expect(() =>
    base.ledger.sessions.admit(
      source,
      {
        state: 'gap',
        cursor: { ...baseline, sequence: 99 },
        floor: 50,
        reason: 'retention',
      },
      base.settings,
    ),
  ).toThrow('observation gap (retention)');
  expect(base.ledger.sessions.list()[0]).toEqual(source);
  base.ledger.activations.setIntent(2, 'interrupted', false);
  expect(base.ledger.sessions.list()).toEqual([]);
  base.ledger.activations.setIntent(3, 'armed', false);
  base.ledger.sessions.initialise(f.definitions, f.activation, { ...baseline, sequence: 99 });
  expect(() => base.ledger.sessions.requireCurrent(source)).toThrow('cursor changed');
  expect(base.ledger.sessions.list()[0]!.cursor.sequence).toBe(99);
  expect(base.ledger.page('executions')).toHaveLength(0);
});
