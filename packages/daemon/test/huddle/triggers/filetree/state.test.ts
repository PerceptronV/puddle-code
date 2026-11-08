import { afterEach, expect, it } from 'vitest';
import { filetreeFixture } from '../../../helpers/huddle/filetree.js';
const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup()),
);
function fixture() {
  const f = filetreeFixture();
  cleanups.push(f.cleanup);
  return f;
}
const files = (count: number, prefix = 'file') =>
  Array.from({ length: count }, (_, i) => ({ path: `${prefix}-${i}`, signature: String(i) }));
it('retains bounded batches and cursor progress through queue refusal and reopen', () => {
  const f = fixture(),
    now = Date.now();
  f.ledger.filetrees.initialise(f.definition, f.activation, []);
  expect(f.ledger.filetrees.capture(0, 2, files(130), now)).toBe(true);
  f.ledger.filetrees.admit(0, 2, { ...f.settings, maxQueuedEvents: 1 }, now);
  expect(() => f.ledger.filetrees.admit(0, 2, { ...f.settings, maxQueuedEvents: 1 }, now)).toThrow(
    'queue is full',
  );
  expect(f.ledger.filetrees.current(0)).toMatchObject({
    sequence: 1,
    pending: { batch: 1 },
    snapshot: [],
  });
  const ledger = f.base.reopen();
  ledger.filetrees.admit(0, 2, f.settings, now);
  ledger.filetrees.admit(0, 2, f.settings, now);
  expect(ledger.filetrees.admit(0, 2, f.settings, now)).toBeNull();
  const events = ledger.page('inbox').map((row) => JSON.parse(row.body).event);
  expect(events.map((event) => event.data.changes.length)).toEqual([64, 64, 2]);
  expect(events.map((event) => event.data.final)).toEqual([false, false, true]);
  expect(
    new Set(
      events.flatMap((event) => event.data.changes.map((change: { path: string }) => change.path)),
    ).size,
  ).toBe(130);
  expect(events[0].resource).toEqual({ kind: 'worktree', worktree: f.worktree });
  expect(events[0].occurredAt).toBeUndefined();
  expect(ledger.filetrees.capture(0, 2, files(130), now)).toBe(false);
});
it('keeps two full snapshots within their limits while replacing every file', () => {
  const f = fixture(),
    now = Date.now();
  f.ledger.filetrees.initialise(f.definition, f.activation, files(1024, 'z'));
  f.ledger.filetrees.capture(0, 2, files(1024, 'a'), now);
  for (let i = 0; i < 32; i++)
    expect(f.ledger.filetrees.admit(0, 2, f.settings, now)).not.toBeNull();
  expect(f.ledger.filetrees.current(0)!.snapshot).toHaveLength(1024);
  expect(f.ledger.filetrees.current(0)!.pending).toBeNull();
});
it('fences stale admission and starts a new baseline after explicit rearming', () => {
  const f = fixture(),
    now = Date.now();
  f.ledger.filetrees.initialise(f.definition, f.activation, []);
  f.ledger.filetrees.capture(0, 2, files(3), now);
  f.ledger.activations.setIntent(2, 'interrupted', false);
  expect(() => f.ledger.filetrees.admit(0, 2, f.settings, now)).toThrow('activation changed');
  f.ledger.activations.setIntent(3, 'armed', false);
  f.ledger.filetrees.initialise(f.definition, f.activation, files(4));
  expect(f.ledger.filetrees.capture(0, 4, files(4), now)).toBe(false);
  expect(f.ledger.page('inbox')).toHaveLength(0);
});
