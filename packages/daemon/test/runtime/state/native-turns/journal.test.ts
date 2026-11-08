import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runtimeNativeTurnPageSchema, type RuntimeNativeTurnRecord } from '@puddle/shared';
import { RuntimeNativeTurnJournal } from '../../../../src/runtime/state/native-turns/journal.js';
import { readNativeTurnJournal } from '../../../../src/runtime/state/native-turns/records.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanups.splice(0).reverse()) await close();
});
function fixture(
  options: ConstructorParameters<typeof RuntimeNativeTurnJournal>[3] = {},
  allowance?: ConstructorParameters<typeof RuntimeNativeTurnJournal>[2],
) {
  const directory = mkdtempSync(join(tmpdir(), 'puddle-native-turns-'));
  const identity = {
    runtime_id: randomUUID(),
    incarnation: randomUUID(),
    launch_id: randomUUID(),
    session_id: randomUUID(),
    profile_id: '1111111111',
    project_id: '2222222222',
    canonical_worktree_path: directory,
  };
  const journal = new RuntimeNativeTurnJournal(directory, identity, allowance, options);
  cleanups.push(async () => {
    await journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const event = (
    patch: Partial<Omit<RuntimeNativeTurnRecord, 'sequence'>> = {},
  ): Omit<RuntimeNativeTurnRecord, 'sequence'> => ({
    event: 'completed',
    nativeTurnId: randomUUID(),
    agentSessionRef: 'native-ref',
    observedAt: new Date().toISOString(),
    segmentId: identity.runtime_id,
    sessionId: identity.session_id,
    origin: { kind: 'external' },
    reply: 'reply',
    ...patch,
  });
  return { directory, identity, journal, event };
}
it('retains source history independently for multiple cursors and validates the durable owner identity', async () => {
  const f = fixture(),
    baseline = f.journal.status().cursor;
  for (let i = 0; i < 20; i++) expect(f.journal.append(f.event())).toBe(true);
  expect(await f.journal.flush()).toBe(true);
  const first = runtimeNativeTurnPageSchema.parse(f.journal.read(baseline));
  expect(first).toMatchObject({
    state: 'events',
    cursor: { sequence: 16 },
    head: 20,
    persistencePending: false,
  });
  expect(f.journal.read(first.cursor)).toMatchObject({ state: 'events', cursor: { sequence: 20 } });
  expect(f.journal.read(baseline)).toEqual(first);
  expect(readNativeTurnJournal(f.directory, f.identity).records).toHaveLength(20);
  expect(() =>
    readNativeTurnJournal(f.directory, { ...f.identity, incarnation: randomUUID() }),
  ).toThrow('identity changed');
});
it('reports byte/count eviction and epoch/ahead gaps without silent rebasing', async () => {
  const f = fixture({ maxRecords: 2 }),
    baseline = f.journal.status().cursor;
  for (let i = 0; i < 3; i++) f.journal.append(f.event());
  expect(await f.journal.flush()).toBe(true);
  expect(f.journal.read(baseline)).toMatchObject({ state: 'gap', reason: 'retention', floor: 1 });
  expect(f.journal.read({ ...baseline, sequence: 4 })).toMatchObject({
    state: 'gap',
    reason: 'ahead',
  });
  expect(f.journal.read({ ...baseline, epoch: 'f'.repeat(32) })).toMatchObject({
    state: 'gap',
    reason: 'epoch',
  });
  const bytes = fixture({ maxBytes: 2048 }),
    cursor = bytes.journal.status().cursor;
  bytes.journal.append(bytes.event({ reply: '\u0001'.repeat(1024) }));
  await bytes.journal.flush();
  expect(bytes.journal.read(cursor)).toMatchObject({ state: 'gap', reason: 'retention', floor: 1 });
  expect(readNativeTurnJournal(bytes.directory, bytes.identity).records).toEqual([]);
});
it('deduplicates repeated outcomes and marks conflicting evidence as a gap', () => {
  const f = fixture(),
    baseline = f.journal.status().cursor,
    event = f.event();
  expect(f.journal.append(event)).toBe(true);
  expect(
    f.journal.append({ ...event, observedAt: new Date(Date.now() + 1000).toISOString() }),
  ).toBe(false);
  expect(f.journal.status().cursor.sequence).toBe(1);
  expect(f.journal.append({ ...event, reply: 'conflicting reply' })).toBe(false);
  expect(f.journal.read(baseline)).toMatchObject({ state: 'gap', reason: 'retention', floor: 2 });
});
it('keeps persistence failure explicit, retries with backoff and never marks concurrent appends saved early', async () => {
  let finish!: () => void;
  const write = vi
    .fn<NonNullable<ConstructorParameters<typeof RuntimeNativeTurnJournal>[3]>['write']>()
    .mockRejectedValueOnce(new Error('disk full'));
  const f = fixture({ write });
  f.journal.append(f.event());
  expect(await f.journal.flush()).toBe(false);
  expect(f.journal.read(null).persistencePending).toBe(true);
  expect(await f.journal.flush()).toBe(false);
  expect(write).toHaveBeenCalledTimes(1);
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 2000);
  write
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  const flushing = f.journal.flush();
  await Promise.resolve();
  f.journal.append(f.event());
  finish();
  expect(await flushing).toBe(false);
  expect(write.mock.calls[1]![1].records).toHaveLength(1);
  expect(await f.journal.flush()).toBe(true);
  expect(write.mock.calls[2]![1].records).toHaveLength(2);
});
it('turns memory refusal or invalid observations into explicit loss without throwing into the agent', async () => {
  let allow = false;
  const f = fixture({}, { reserve: () => (allow ? () => {} : null) }),
    cursor = f.journal.status().cursor;
  expect(f.journal.append(f.event())).toBe(false);
  expect(f.journal.read(cursor)).toMatchObject({ state: 'gap', reason: 'retention' });
  expect(await f.journal.flush()).toBe(false);
  allow = true;
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 2000);
  expect(await f.journal.flush()).toBe(true);
  const baseline = f.journal.status().cursor;
  expect(f.journal.append(f.event({ reply: undefined }))).toBe(false);
  expect(f.journal.read(baseline)).toMatchObject({ state: 'gap', floor: 2 });
});
