import { afterEach, expect, it } from 'vitest';
import { gitFixture } from '../../../helpers/huddle/git.js';
const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup()),
);
async function fixture() {
  const f = await gitFixture();
  cleanups.push(f.cleanup);
  return f;
}
const refs = (count: number, prefix = 'branch') =>
  Array.from({ length: count }, (_, i) => ({
    ref: `refs/heads/${prefix}-${i}`,
    oid: String(i).padStart(40, '0'),
    target: null,
  }));
it('retains batches and old/new object IDs through queue refusal and reopen', async () => {
  const f = await fixture(),
    now = Date.now();
  f.ledger.git.initialise(f.definition, f.activation, [], '/git');
  f.ledger.git.capture(0, 2, refs(130), now);
  f.ledger.git.admit(0, 2, { ...f.settings, maxQueuedEvents: 1 }, now);
  expect(() => f.ledger.git.admit(0, 2, { ...f.settings, maxQueuedEvents: 1 }, now)).toThrow(
    'queue is full',
  );
  expect(f.ledger.git.current(0)).toMatchObject({
    sequence: 1,
    snapshot: [],
    pending: { batch: 1 },
  });
  const ledger = f.base.reopen();
  ledger.git.admit(0, 2, f.settings, now);
  ledger.git.admit(0, 2, f.settings, now);
  expect(ledger.git.admit(0, 2, f.settings, now)).toBeNull();
  const events = ledger.page('inbox').map((row) => JSON.parse(row.body).event);
  expect(events.map((event) => event.data.changes.length)).toEqual([64, 64, 2]);
  expect(events.map((event) => event.data.final)).toEqual([false, false, true]);
  expect(events[0].data.repository).toBe(f.worktree);
  expect(events[0].data.changes[0]).toMatchObject({ oldOid: null, newOid: '0'.repeat(40) });
  expect(events[0].resource).toEqual({ kind: 'worktree', worktree: f.worktree });
  expect(events[0].occurredAt).toBeUndefined();
  expect(ledger.git.capture(0, 2, refs(130), now)).toBe(false);
});
it('bounds full snapshot replacement and fences old generations and changed repository identity', async () => {
  const f = await fixture(),
    now = Date.now();
  f.ledger.git.initialise(f.definition, f.activation, refs(1024, 'old'), '/git');
  expect(() => f.ledger.git.initialise(f.definition, f.activation, [], '/other')).toThrow(
    'identity changed',
  );
  f.ledger.git.capture(0, 2, refs(1024, 'new'), now);
  for (let i = 0; i < 32; i++) f.ledger.git.admit(0, 2, f.settings, now);
  expect(f.ledger.git.current(0)!.pending).toBeNull();
  f.ledger.activations.setIntent(2, 'interrupted', false);
  expect(() => f.ledger.git.capture(0, 2, [], now)).toThrow('activation changed');
  f.ledger.activations.setIntent(3, 'armed', false);
  f.ledger.git.initialise(f.definition, f.activation, [], '/git');
  expect(f.ledger.git.capture(0, 4, [], now)).toBe(false);
});
