import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  completionHuddleTrigger,
  coreHuddleComponents,
  validateHuddleValue,
  type RuntimeNativeTurnPage,
  type RuntimeNativeTurnRecord,
} from '@puddle/shared';
import { completionSourceFixture } from '../../../helpers/huddle/completion-source.js';

const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture(limits?: { records?: number; bytes?: number }) {
  const f = completionSourceFixture(limits);
  cleanups.push(f.base.cleanup);
  return f;
}
function page(
  f: ReturnType<typeof fixture>,
  records: RuntimeNativeTurnRecord[],
): RuntimeNativeTurnPage {
  const sequence = records.at(-1)?.sequence ?? f.base.ledger.completions.list()[0]!.cursor.sequence;
  return {
    state: 'events',
    records,
    cursor: { ...f.baseline.cursor, sequence },
    head: sequence,
    persistencePending: false,
  };
}

it('commits external completions and cursor atomically, then observes a lost reply after reopen', () => {
  const f = fixture(),
    { base } = f;
  const source = base.ledger.completions.list()[0]!;
  const records = [f.record(11), f.record(12)],
    input = page(f, records);
  expect(() =>
    base.ledger.completions.admit(source, input, { ...base.settings, maxQueuedEvents: 1 }),
  ).toThrow('queue is full');
  expect(base.ledger.page('executions')).toHaveLength(0);
  expect(base.ledger.completions.list()[0]).toEqual(source);
  expect(base.ledger.completions.admit(source, input, base.settings)).toBe(2);
  base.reopen();
  expect(base.ledger.completions.list()[0]!.cursor).toEqual(input.cursor);
  expect(() => base.ledger.completions.admit(source, input, base.settings)).toThrow(
    'cursor changed',
  );
  expect(
    base.ledger.completions.admit(base.ledger.completions.list()[0]!, page(f, []), base.settings),
  ).toBe(0);
  expect(base.ledger.page('executions')).toHaveLength(2);
  const events = base.ledger.page('inbox').map((row) => JSON.parse(row.body).event);
  expect(events.map((event) => event.data)).toEqual(
    records.map((record) => ({
      ...record,
      runtimeId: f.baseline.target.identity.runtime_id,
      worktree: f.worktree,
    })),
  );
  for (const event of events) {
    expect(event.scope).toEqual(base.identity);
    expect(event.resource).toEqual({
      kind: 'session',
      sessionId: f.session,
      runtimeId: f.baseline.target.identity.runtime_id,
      worktree: f.worktree,
    });
    expect(event.occurredAt).toBeUndefined();
    expect(validateHuddleValue(completionHuddleTrigger.outputs.event!.schema, event.data)).toEqual(
      [],
    );
  }
});

it('advances noncompletion, unknown and automated observations without resetting feedback budgets', () => {
  const f = fixture(),
    { base } = f;
  const records = [
    f.record(11, { event: 'started', reply: undefined }),
    f.record(12, { event: 'failed', reply: undefined, error: 'failed' }),
    f.record(13, { event: 'interrupted', reply: undefined, error: 'takeover' }),
    f.record(14, { origin: { kind: 'unknown' } }),
    f.record(15, { origin: { kind: 'automation', turn: 1 } }),
    f.record(16, {
      origin: {
        kind: 'automation',
        turn: 2,
        huddle: {
          huddleId: base.identity.huddleId,
          executionId: randomUUID(),
          operationId: randomUUID(),
        },
      },
    }),
  ];
  expect(
    base.ledger.completions.admit(
      base.ledger.completions.list()[0]!,
      page(f, records),
      base.settings,
    ),
  ).toBe(0);
  expect(base.ledger.completions.list()[0]!.cursor.sequence).toBe(16);
  expect(base.ledger.page('executions')).toEqual([]);
  expect(base.ledger.page('budgets')).toEqual([]);
  expect(base.ledger.page('cursors')).toEqual([]);
  expect(
    base.ledger.completions.admit(
      base.ledger.completions.list()[0]!,
      page(f, [f.record(17)]),
      base.settings,
    ),
  ).toBe(1);
});

it('preserves the whole page and cursor on retained-capacity refusal', () => {
  const f = fixture({ records: 6 }),
    { base } = f;
  const source = base.ledger.completions.list()[0]!,
    before = base.ledger.usage();
  expect(() =>
    base.ledger.completions.admit(source, page(f, [f.record(11)]), base.settings),
  ).toThrow('capacity exceeded');
  expect(base.ledger.usage()).toEqual(before);
  expect(base.ledger.completions.list()[0]).toEqual(source);
});

it('cannot truncate a native reply to fit the huddle value envelope or partially admit its page', () => {
  const f = fixture(),
    { base } = f,
    source = base.ledger.completions.list()[0]!;
  for (const reply of ['x'.repeat(256 * 1024), '\u0000'.repeat(45 * 1024)]) {
    expect(() =>
      base.ledger.completions.admit(
        source,
        page(f, [f.record(11), f.record(12, { reply })]),
        base.settings,
      ),
    ).toThrow('reply was not truncated');
    expect(base.ledger.page('executions')).toEqual([]);
    expect(base.ledger.completions.list()[0]).toEqual(source);
  }
});

it.each(['sessionId', 'segmentId', 'agentSessionRef'] as const)(
  'rejects a changed %s even on a suppressed record',
  (key) => {
    const f = fixture(),
      { base } = f,
      source = base.ledger.completions.list()[0]!;
    expect(() =>
      base.ledger.completions.admit(
        source,
        page(f, [f.record(11, { [key]: randomUUID(), origin: { kind: 'unknown' } })]),
        base.settings,
      ),
    ).toThrow('pinned session/segment/native identity');
    expect(base.ledger.completions.list()[0]).toEqual(source);
  },
);

it('rejects unbound native records rather than assigning the selected placement', () => {
  const f = fixture(),
    { base } = f;
  expect(() =>
    base.ledger.completions.admit(
      base.ledger.completions.list()[0]!,
      page(f, [f.record(11, { sessionId: null })]),
      base.settings,
    ),
  ).toThrow('pinned session/segment/native identity');
});

it('does not advance on gaps, pending persistence, missing positions or backwards cursors', () => {
  const f = fixture(),
    { base } = f,
    source = base.ledger.completions.list()[0]!;
  const good = page(f, [f.record(11)]);
  const inputs: RuntimeNativeTurnPage[] = [
    { ...good, persistencePending: true },
    { state: 'baseline', cursor: f.baseline.cursor, persistencePending: false },
    ...(['retention', 'epoch', 'ahead'] as const).map((reason) => ({
      state: 'gap' as const,
      cursor: { ...f.baseline.cursor, sequence: 99 },
      floor: 50,
      reason,
      persistencePending: false,
    })),
    { ...good, cursor: { epoch: 'b'.repeat(32), sequence: 11 } },
    {
      state: 'events',
      records: [],
      cursor: { ...f.baseline.cursor, sequence: 9 },
      head: 11,
      persistencePending: false,
    },
    page(f, [f.record(12)]),
    {
      state: 'events',
      records: [f.record(11)],
      cursor: { ...f.baseline.cursor, sequence: 12 },
      head: 12,
      persistencePending: false,
    },
    {
      state: 'events',
      records: [],
      cursor: { ...f.baseline.cursor, sequence: 12 },
      head: 12,
      persistencePending: false,
    },
  ];
  for (const input of inputs) {
    expect(() => base.ledger.completions.admit(source, input, base.settings)).toThrow();
    expect(base.ledger.completions.list()[0]).toEqual(source);
    expect(base.ledger.page('executions')).toEqual([]);
  }
});

it('retains progress within a generation and requires fresh explicit intent to change targets', () => {
  const f = fixture(),
    { base } = f,
    source = base.ledger.completions.list()[0]!;
  base.ledger.completions.admit(source, page(f, [f.record(11)]), base.settings);
  base.ledger.completions.initialise(f.definitions, f.activation, [f.baseline]);
  expect(base.ledger.completions.list()[0]!.cursor.sequence).toBe(11);
  const changed = {
    ...f.baseline,
    target: {
      ...f.baseline.target,
      identity: { ...f.baseline.target.identity, incarnation: randomUUID() },
    },
  };
  expect(() => base.ledger.completions.initialise(f.definitions, f.activation, [changed])).toThrow(
    'target changed',
  );
  base.ledger.activations.setIntent(2, 'interrupted', false);
  expect(base.ledger.completions.list()).toEqual([]);
  expect(() =>
    base.ledger.completions.admit(source, page(f, [f.record(12)]), base.settings),
  ).toThrow('cursor changed');
  base.ledger.activations.setIntent(3, 'armed', false);
  const fresh = { ...changed, cursor: { epoch: 'b'.repeat(32), sequence: 99 } };
  base.ledger.completions.initialise(f.definitions, f.activation, [fresh]);
  expect(base.ledger.completions.list()[0]!.target).toEqual(fresh.target);
  expect(base.ledger.completions.list()[0]!.cursor).toEqual(fresh.cursor);
  expect(() => base.ledger.completions.requireCurrent(source)).toThrow('cursor changed');
  expect(base.ledger.page('executions')).toHaveLength(1);
});

it('publishes the exact completion contract in the shared creation catalogue', () => {
  expect(coreHuddleComponents.get(`${completionHuddleTrigger.id}@1`)).toEqual(
    completionHuddleTrigger,
  );
});

it('routes an admitted completion into the captured graph once after reopening the ledger', () => {
  const f = fixture(),
    { base } = f;
  base.ledger.completions.admit(
    base.ledger.completions.list()[0]!,
    page(f, [f.record(11)]),
    f.snapshot.definition.execution,
  );
  const executionId = base.ledger.page('executions')[0]!.id;
  base.reopen();
  const graph = base.ledger.graph(
    f.snapshot.digest,
    f.snapshot.definition,
    new Map(Object.entries(f.snapshot.components)),
  );
  expect(graph.start(executionId)).toBe(true);
  expect(graph.start(executionId)).toBe(false);
  const invocations = base.ledger.page('invocations');
  expect(invocations).toHaveLength(1);
  expect(JSON.parse(invocations[0]!.body)).toMatchObject({
    node: 'worker',
    executionId,
    iteration: 0,
    inputs: {
      value: { nativeTurnId: 'native-11', reply: 'reply 11', origin: { kind: 'external' } },
    },
  });
  expect(base.ledger.executions.get(executionId)).toMatchObject({
    state: 'running',
    activationId: f.activation.id,
    invocations: 1,
  });
});
