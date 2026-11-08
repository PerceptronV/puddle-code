import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  calendarHuddleTrigger,
  dateHuddleTrigger,
  HUDDLE_RUNTIME_CAPABILITIES,
  type HuddleComponent,
  type HuddleJson,
} from '@puddle/shared';
import { huddleLedgerFixture } from '../../helpers/huddle/ledger.js';
import { schedulerSnapshot } from '../../helpers/huddle/scheduler.js';
import { withTrigger } from '../../helpers/huddle/trigger.js';
import { HuddleRevisionStore } from '../../../src/runtime/huddle/state/revisions.js';
import { HuddleRevisionController } from '../../../src/runtime/huddle/control/revisions.js';
import { scheduleDefinitions } from '../../../src/runtime/huddle/triggers/calendar/definitions.js';
import { requireHuddleFeatures } from '../../../src/runtime/huddle/triggers/definitions.js';
import { HuddleTimerController } from '../../../src/runtime/huddle/triggers/controller.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  vi.useRealTimers();
});
const now = Date.parse('2026-01-01T00:00:00Z');
function fixture(
  component = dateHuddleTrigger,
  parameters: Record<string, HuddleJson> = { at: new Date(now + 1000).toISOString() },
  armedAt = now,
) {
  const base = huddleLedgerFixture();
  cleanups.push(base.cleanup);
  const snapshot = withTrigger(
    schedulerSnapshot(base.identity.huddleId, ''),
    component,
    parameters,
  );
  const store = new HuddleRevisionStore(base.home, base.identity.runtimeId, base.identity.huddleId);
  const revisions = new HuddleRevisionController(base.ledger, store);
  const { activation } = revisions.apply(
    snapshot,
    { id: randomUUID(), worktree: base.home, variables: {}, bindings: {} },
    0,
  );
  base.ledger.activations.setIntent(1, 'armed', false);
  const definitions = scheduleDefinitions(snapshot, activation);
  base.ledger.schedules.synchronise(activation, definitions, armedAt);
  return { ...base, base, snapshot, store, revisions, activation, definitions };
}
it('consumes a one-off atomically and retains its disposition across reopen and Resume', () => {
  const f = fixture();
  expect(f.ledger.schedules.plan(now)[0]!.occurrences).toEqual([]);
  const plan = f.ledger.schedules.plan(now + 1000)[0]!;
  expect(f.ledger.schedules.admit(plan, f.settings, now + 1000)!.duplicate).toBe(false);
  const ledger = f.base.reopen();
  ledger.activations.setIntent(2, 'interrupted', false);
  ledger.activations.setIntent(3, 'armed', false);
  ledger.schedules.synchronise(f.activation, f.definitions, now + 10000);
  expect(ledger.schedules.current()!.schedules[0]).toMatchObject({ disposition: 'admitted' });
  expect(ledger.schedules.plan(now + 10000)[0]!.occurrences).toEqual([]);
  expect(ledger.page('inbox')).toHaveLength(1);
});
it('preserves a one-off on queue refusal and rejects a stale prepared plan', () => {
  const f = fixture();
  const plan = f.ledger.schedules.plan(now + 1000)[0]!;
  const accept = vi.spyOn(f.ledger.executions, 'accept').mockImplementation(() => {
    throw new Error('queue full');
  });
  expect(() => f.ledger.schedules.admit(plan, f.settings, now + 1000)).toThrow('queue full');
  expect(f.ledger.schedules.current()!.schedules[0]).toMatchObject({ disposition: 'pending' });
  expect(plan.occurrences).toHaveLength(1);
  accept.mockRestore();
  f.ledger.activations.setIntent(2, 'interrupted', false);
  expect(() => f.ledger.schedules.admit(plan, f.settings, now + 1000)).toThrow(
    'activation changed',
  );
});
it('does not advance a calendar cursor when the real event queue is full', () => {
  const f = fixture(calendarHuddleTrigger, { missed: 'catch-up', maxCatchUp: 3 });
  const late = now + 10 * 86400000;
  const plan = f.ledger.schedules.plan(late)[0]!;
  f.ledger.schedules.admit(plan, { ...f.settings, maxQueuedEvents: 1 }, late);
  const before = f.ledger.schedules.current();
  expect(() => f.ledger.schedules.admit(plan, { ...f.settings, maxQueuedEvents: 1 }, late)).toThrow(
    'queue is full',
  );
  expect(f.ledger.schedules.current()).toEqual(before);
  const ledger = f.base.reopen();
  const remaining = ledger.schedules.plan(late)[0]!;
  expect(remaining.occurrences).toHaveLength(2);
  expect(remaining.occurrences[0]!.data.skipped).toBe(0);
  ledger.schedules.admit(remaining, f.settings, late);
  expect(ledger.page('inbox')).toHaveLength(2);
});
it('records the explicit past-date policy and resets it only on a new activation', () => {
  const f = fixture(dateHuddleTrigger, { at: new Date(now - 1000).toISOString(), past: 'skip' });
  expect(f.ledger.schedules.current()!.schedules[0]).toMatchObject({ disposition: 'skipped' });
  expect(f.ledger.schedules.plan(now)[0]!.occurrences).toEqual([]);
  const snapshot = withTrigger(f.snapshot, dateHuddleTrigger, {
    at: new Date(now - 1000).toISOString(),
    past: 'fire',
  });
  const { activation } = f.revisions.apply(
    snapshot,
    { id: randomUUID(), worktree: f.home, variables: {}, bindings: {} },
    2,
  );
  f.ledger.schedules.synchronise(activation, scheduleDefinitions(snapshot, activation), now);
  const plan = f.ledger.schedules.plan(now)[0]!;
  expect(f.ledger.schedules.admit(plan, f.settings, now)).not.toBeNull();
});
it('does not skip a future one-off merely because the owner wakes after its deadline', () => {
  const f = fixture(dateHuddleTrigger, { at: new Date(now + 1000).toISOString(), past: 'skip' });
  const plan = f.ledger.schedules.plan(now + 10000)[0]!;
  expect(f.ledger.schedules.admit(plan, f.settings, now + 10000)).not.toBeNull();
});
it('commits bounded calendar catch-up and omits paused time without replay after rollback', () => {
  const f = fixture(calendarHuddleTrigger, { missed: 'catch-up', maxCatchUp: 3 });
  const late = now + 10 * 86400000;
  const plan = f.ledger.schedules.plan(late)[0]!;
  while (plan.occurrences.length) f.ledger.schedules.admit(plan, f.settings, late);
  expect(f.ledger.page('inbox').map((row) => JSON.parse(row.body).event.data.skipped)).toEqual([
    7, 0, 0,
  ]);
  f.ledger.activations.setIntent(2, 'interrupted', false);
  f.ledger.activations.setIntent(3, 'armed', false);
  f.ledger.schedules.synchronise(f.activation, f.definitions, now);
  expect(f.ledger.schedules.plan(late)[0]!.occurrences).toEqual([]);
  f.ledger.activations.setIntent(4, 'interrupted', false);
  f.ledger.activations.setIntent(5, 'armed', false);
  f.ledger.schedules.synchronise(f.activation, f.definitions, late + 86400000);
  expect(f.ledger.schedules.plan(late + 86400000)[0]!.occurrences).toEqual([]);
});
it('uses one owner timer and releases its reservation after the last one-off', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const f = fixture(),
    admitted = vi.fn(),
    failed = vi.fn(),
    release = vi.fn();
  const timers = new HuddleTimerController(
    f.ledger,
    f.store,
    HUDDLE_RUNTIME_CAPABILITIES,
    admitted,
    failed,
    vi.fn(),
    { reserve: () => release },
  );
  cleanups.push(() => timers.stop());
  timers.refresh();
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(admitted).toHaveBeenCalledOnce();
  expect(failed).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(release).toHaveBeenCalledOnce();
});
it('schedules one calendar event across a repeated hour without a second admission', async () => {
  const armedAt = Date.parse('2026-11-01T05:00:00Z');
  vi.useFakeTimers();
  vi.setSystemTime(armedAt);
  const f = fixture(
    calendarHuddleTrigger,
    { timeZone: 'America/New_York', time: '01:30' },
    armedAt,
  );
  const admitted = vi.fn(),
    failed = vi.fn();
  const timers = new HuddleTimerController(
    f.ledger,
    f.store,
    HUDDLE_RUNTIME_CAPABILITIES,
    admitted,
    failed,
    vi.fn(),
  );
  cleanups.push(() => timers.stop());
  timers.refresh();
  await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
  expect(admitted).toHaveBeenCalledOnce();
  expect(failed).not.toHaveBeenCalled();
  expect(f.ledger.page('inbox')).toHaveLength(1);
  expect(JSON.parse(f.ledger.page('inbox')[0]!.body).event.data.scheduledAt).toBe(
    '2026-11-01T05:30:00.000Z',
  );
  expect(vi.getTimerCount()).toBe(1);
});
it('validates calendar/date settings before activation and gates old runtimes', () => {
  const f = fixture();
  const { calendar: _, ...old } = HUDDLE_RUNTIME_CAPABILITIES;
  expect(() => requireHuddleFeatures(f.snapshot, old)).toThrow('calendar/date');
  const invalid: Array<[HuddleComponent, Record<string, HuddleJson>]> = [
    [calendarHuddleTrigger, { timeZone: 'Invalid/Zone' }],
    [calendarHuddleTrigger, { time: '24:30' }],
    [calendarHuddleTrigger, { weekdays: [1, 1] }],
    [dateHuddleTrigger, { at: '2026-01-01T00:00:00' }],
    [dateHuddleTrigger, { at: '2026-02-30T00:00:00Z' }],
  ];
  for (const [component, parameters] of invalid) {
    const snapshot = withTrigger(f.snapshot, component, parameters);
    expect(() =>
      f.revisions.apply(
        snapshot,
        { id: randomUUID(), worktree: f.home, variables: {}, bindings: {} },
        2,
      ),
    ).toThrow();
    expect(f.ledger.activations.current().generation).toBe(2);
  }
});
