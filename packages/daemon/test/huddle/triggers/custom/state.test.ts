import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { huddleLedgerFixture } from '../../../helpers/huddle/ledger.js';
import { customTriggerSnapshot } from '../../../helpers/huddle/custom-trigger.js';
import { HuddleRevisionStore } from '../../../../src/runtime/huddle/state/revisions.js';
import { HuddleRevisionController } from '../../../../src/runtime/huddle/control/revisions.js';
import { customTriggerDefinitions } from '../../../../src/runtime/huddle/triggers/custom/definitions.js';
import { HuddleStateDatabase } from '../../../../src/runtime/huddle/state/database.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close());
});
function fixture(resume: 'continue' | 'fresh' = 'continue') {
  const f = huddleLedgerFixture();
  cleanups.push(f.cleanup);
  const snapshot = customTriggerSnapshot(f.identity.huddleId, '', f.home, resume);
  const store = new HuddleRevisionStore(f.home, f.identity.runtimeId, f.identity.huddleId);
  const revisions = new HuddleRevisionController(f.ledger, store);
  const { activation } = revisions.apply(
    snapshot,
    {
      id: randomUUID(),
      worktree: f.home,
      variables: {},
      bindings: { source: { worktree: f.home } },
    },
    0,
  );
  f.ledger.activations.setIntent(1, 'armed', false);
  const definitions = customTriggerDefinitions(snapshot, activation);
  const [source] = f.ledger.customTriggers.synchronise(activation, definitions);
  const emit = (id: string, value = 1) =>
    f.ledger.customTriggers.admit(
      source!,
      { id, port: 'event', data: value, nextCursor: id },
      snapshot.components.source,
      f.settings,
    );
  return { f, snapshot, activation, definitions, source: source!, emit };
}

it('atomically admits events and cursors, deduplicates lost acknowledgements and never rewinds a cursor', () => {
  const { f, emit, source, snapshot } = fixture();
  const first = emit('one');
  expect(first.duplicate).toBe(false);
  emit('two', 2);
  f.reopen();
  expect(emit('one')).toEqual({ ...first, duplicate: true });
  expect(f.ledger.customTriggers.list()[0]!.cursor).toBe('two');
  expect(f.ledger.page('executions')).toHaveLength(2);
  expect(() => emit('one', 42)).toThrow('conflicts');
  expect(() =>
    f.ledger.customTriggers.admit(
      source,
      { id: 'three', port: 'event', data: 3, nextCursor: 'three' },
      snapshot.components.source,
      { ...f.settings, maxQueuedEvents: 1 },
    ),
  ).toThrow('queue is full');
  expect(f.ledger.customTriggers.list()[0]!.cursor).toBe('two');
  expect(f.ledger.page('executions')).toHaveLength(2);
});

it.each(['continue', 'fresh'] as const)(
  'honours %s resume policy and rejects old-generation callbacks',
  (resume) => {
    const { f, source, activation, definitions, emit } = fixture(resume);
    emit('one');
    f.ledger.activations.setIntent(2, 'interrupted', false);
    expect(() => emit('two')).toThrow('no longer current');
    f.ledger.activations.setIntent(3, 'armed', false);
    const [next] = f.ledger.customTriggers.synchronise(activation, definitions);
    expect(next!.cursor).toBe(resume === 'continue' ? 'one' : null);
    expect(next!.id === source.id).toBe(resume === 'continue');
    expect(() => emit('two')).toThrow('no longer current');
  },
);

it('checkpoints source baselines without creating graph work and preserves explicit gaps', () => {
  const { f, source, emit } = fixture();
  f.ledger.customTriggers.checkpoint(source, { after: 100 });
  expect(f.ledger.page('executions')).toHaveLength(0);
  expect(() => f.ledger.customTriggers.checkpoint(source, 'x'.repeat(70 * 1024))).toThrow('64 KiB');
  f.ledger.customTriggers.health(source, {
    state: 'gap',
    message: 'Expired source cursor',
    after: { after: 100 },
  });
  expect(() => emit('one')).toThrow('gap');
  expect(() => f.ledger.customTriggers.health(source, { state: 'ready' })).toThrow('terminal');
  f.ledger.customTriggers.close(source);
  expect(f.ledger.customTriggers.list()[0]!.health.state).toBe('gap');
});

it('rolls back inbox, budgets and cursors together when subscription progress cannot be retained', () => {
  const { f, emit } = fixture();
  const before = f.ledger.usage();
  const original = HuddleStateDatabase.prototype.put;
  vi.spyOn(HuddleStateDatabase.prototype, 'put').mockImplementation(function (
    this: HuddleStateDatabase,
    ...args
  ) {
    original.apply(this, args);
    if (args[0] === 'custom-sources') throw new Error('Fixture persistence fault');
  });
  expect(() => emit('one')).toThrow('persistence fault');
  expect(f.ledger.page('inbox')).toHaveLength(0);
  expect(f.ledger.page('executions')).toHaveLength(0);
  expect(f.ledger.page('budgets')).toHaveLength(0);
  expect(f.ledger.customTriggers.list()[0]!.cursor).toBeNull();
  expect(f.ledger.usage()).toEqual(before);
});
