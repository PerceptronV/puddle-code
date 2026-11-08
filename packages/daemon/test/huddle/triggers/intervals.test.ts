import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { HUDDLE_RUNTIME_CAPABILITIES } from '@puddle/shared';
import { huddleLedgerFixture } from '../../helpers/huddle/ledger.js';
import { schedulerSnapshot } from '../../helpers/huddle/scheduler.js';
import { withInterval } from '../../helpers/huddle/interval.js';
import { HuddleRevisionStore } from '../../../src/runtime/huddle/state/revisions.js';
import { HuddleRevisionController } from '../../../src/runtime/huddle/control/revisions.js';
import {
  intervalDefinitions,
  requireHuddleFeatures,
} from '../../../src/runtime/huddle/triggers/definitions.js';
import { HuddleTimerController } from '../../../src/runtime/huddle/triggers/controller.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  vi.useRealTimers();
});
function fixture() {
  const f = huddleLedgerFixture();
  cleanups.push(f.cleanup);
  const snapshot = withInterval(schedulerSnapshot(f.identity.huddleId, ''));
  const store = new HuddleRevisionStore(f.home, f.identity.runtimeId, f.identity.huddleId);
  const controller = new HuddleRevisionController(f.ledger, store);
  const { activation } = controller.apply(
    snapshot,
    { id: randomUUID(), worktree: f.home, variables: {}, bindings: {} },
    0,
  );
  f.ledger.activations.setIntent(1, 'armed', false);
  const definitions = intervalDefinitions(snapshot, activation);
  return { ...f, snapshot, store, activation, definitions, base: f };
}
it('retains occurrence progress across reopen and does not consume events on admission failure', () => {
  const f = fixture();
  f.ledger.intervals.synchronise(f.activation, f.definitions, 10000);
  const first = f.ledger.intervals.admit('run', f.settings, 11000)!;
  expect(first.duplicate).toBe(false);
  const reopened = f.base.reopen();
  expect(reopened.intervals.admit('run', f.settings, 11000)).toBeNull();
  expect(() =>
    reopened.intervals.admit('run', { ...f.settings, maxQueuedEvents: 1 }, 12000),
  ).toThrow('queue is full');
  expect(reopened.intervals.current()!.schedules[0]!.last).toBe(1);
  const second = reopened.intervals.admit('run', f.settings, 14000)!;
  expect(second.execution.id).not.toBe(first.execution.id);
  expect(JSON.parse(reopened.page('inbox')[1]!.body).event.data).toMatchObject({
    occurrences: 3,
    skipped: 0,
  });
});
it('starts a fresh interval after interrupt/rearm and ignores old callbacks', () => {
  const f = fixture();
  f.ledger.intervals.synchronise(f.activation, f.definitions, 10000);
  f.ledger.activations.setIntent(2, 'interrupted', false);
  expect(() => f.ledger.intervals.admit('run', f.settings, 50000)).toThrow('activation changed');
  f.ledger.activations.setIntent(3, 'armed', false);
  f.ledger.intervals.synchronise(f.activation, f.definitions, 50000);
  expect(f.ledger.intervals.admit('run', f.settings, 50999)).toBeNull();
  expect(f.ledger.intervals.admit('run', f.settings, 51000)).not.toBeNull();
  expect(JSON.parse(f.ledger.page('inbox')[0]!.body).event.data.occurrences).toBe(1);
});
it('uses one deadline timer, drains catch-up within bounds and releases host memory on stop', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const f = fixture();
  const admitted = vi.fn(),
    failed = vi.fn(),
    guard = vi.fn(),
    release = vi.fn();
  const reserve = vi.fn(() => release);
  const timers = new HuddleTimerController(
    f.ledger,
    f.store,
    HUDDLE_RUNTIME_CAPABILITIES,
    admitted,
    failed,
    guard,
    { reserve },
  );
  cleanups.push(() => timers.stop());
  timers.refresh();
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(999);
  expect(admitted).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(admitted).toHaveBeenCalledTimes(1);
  expect(guard).toHaveBeenCalledTimes(1);
  expect(failed).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  timers.stop();
  expect(release).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('fails visibly before autonomous admission on missing source or unsupported runtime', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const f = fixture();
  const { timers: _, ...legacy } = HUDDLE_RUNTIME_CAPABILITIES;
  expect(() => requireHuddleFeatures(f.snapshot, legacy)).toThrow('interval triggers');
  const failed = vi.fn();
  const timers = new HuddleTimerController(
    f.ledger,
    f.store,
    HUDDLE_RUNTIME_CAPABILITIES,
    vi.fn(),
    failed,
    () => {
      throw new Error('source missing');
    },
  );
  cleanups.push(() => timers.stop());
  timers.refresh();
  await vi.advanceTimersByTimeAsync(1000);
  expect(failed).toHaveBeenCalledTimes(1);
  expect(f.ledger.page('inbox')).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('refuses timer memory admission before retaining an armed schedule', () => {
  const f = fixture();
  const timers = new HuddleTimerController(
    f.ledger,
    f.store,
    HUDDLE_RUNTIME_CAPABILITIES,
    vi.fn(),
    vi.fn(),
    vi.fn(),
    { reserve: () => null },
  );
  expect(() => timers.refresh()).toThrow('host memory capacity');
  expect(f.ledger.intervals.current()).toBeNull();
  timers.stop();
});

it('commits only the bounded recent catch-up set, with older skips recorded once', () => {
  const f = fixture();
  f.definitions[0]!.missed = 'catch-up';
  f.definitions[0]!.maxCatchUp = 3;
  f.ledger.intervals.synchronise(f.activation, f.definitions, 10000);
  for (let i = 0; i < 3; i++)
    expect(f.ledger.intervals.admit('run', f.settings, 20000)).not.toBeNull();
  expect(f.ledger.intervals.admit('run', f.settings, 20000)).toBeNull();
  const events = f.ledger.page('inbox').map((row) => JSON.parse(row.body).event);
  expect(events.map((event) => event.data.scheduledAt)).toEqual([
    '1970-01-01T00:00:18.000Z',
    '1970-01-01T00:00:19.000Z',
    '1970-01-01T00:00:20.000Z',
  ]);
  expect(events.map((event) => event.data.skipped)).toEqual([7, 0, 0]);
  expect(new Set(events.map((event) => event.id)).size).toBe(3);
});

it('turns a timer-state read failure into a reported fault instead of an uncaught callback', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const f = fixture(),
    failed = vi.fn();
  const timers = new HuddleTimerController(
    f.ledger,
    f.store,
    HUDDLE_RUNTIME_CAPABILITIES,
    vi.fn(),
    failed,
    vi.fn(),
  );
  cleanups.push(() => timers.stop());
  timers.refresh();
  const read = vi.spyOn(f.ledger.activations, 'current').mockImplementation(() => {
    throw new Error('state unreadable');
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(failed).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ message: 'Time triggers: state unreadable' }),
  );
  expect(vi.getTimerCount()).toBe(0);
  read.mockRestore();
});
