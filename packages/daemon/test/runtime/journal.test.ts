import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RUNTIME_LIMITS,
  runtimeJournalSchema,
  type RuntimeJournalRecord,
  type RuntimeRetainedEvent,
} from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { RuntimeJournal, readRuntimeJournal } from '../../src/runtime/journal.js';

const homes: string[] = [];
const journals: RuntimeJournal[] = [];
function fixture(options?: ConstructorParameters<typeof RuntimeJournal>[2]) {
  const directory = mkdtempSync(join(tmpdir(), 'puddle-runtime-journal-'));
  homes.push(directory);
  const identity = {
    runtime_id: randomUUID(),
    incarnation: randomUUID(),
    launch_id: randomUUID(),
    profile_id: '1111111111',
    project_id: '2222222222',
    session_id: randomUUID(),
    canonical_worktree_path: directory,
  };
  const journal = new RuntimeJournal(directory, identity, options);
  journals.push(journal);
  return { directory, identity, journal };
}
const event = (cursor: number): RuntimeRetainedEvent => ({
  t: 'exit',
  cursor,
  term: 'shell-1',
  generation: randomUUID(),
  exit_code: 7,
});
afterEach(async () => {
  vi.useRealTimers();
  for (const journal of journals.splice(0)) await journal.close();
  for (const directory of homes.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('runtime event journal', () => {
  it('coalesces private observations without changing offered pages or crossing lifecycle boundaries', async () => {
    const { journal, directory, identity } = fixture();
    const generation = randomUUID();
    const delta = (cursor: number, name: string, value: string): RuntimeRetainedEvent => ({
      t: 'env-delta',
      cursor,
      term: 'shell-1',
      generation,
      delta: { op: 'set', name, value },
    });
    journal.append(delta(1, 'A', 'old'));
    const offered = journal.read(0);
    journal.append(delta(2, 'B', 'other'));
    journal.append(delta(3, 'A', 'new'));
    expect(offered.events).toEqual([delta(1, 'A', 'old')]);
    expect(journal.read(0).events).toEqual([delta(2, 'B', 'other'), delta(3, 'A', 'new')]);
    journal.acknowledge(offered.through);
    expect(journal.read(offered.through).events).toHaveLength(2);
    journal.append({
      t: 'native-lifecycle',
      cursor: 4,
      segment: { id: randomUUID(), start_cursor: 4, agent_session_ref: 'next' },
      previous_segment_id: randomUUID(),
      lifecycle: {
        event: 'session_start',
        agent_session_ref: 'next',
        cwd: directory,
        source: 'clear',
      },
    });
    journal.append(delta(5, 'A', 'next-placement'));
    journal.append({ t: 'cwd', cursor: 6, term: 'shell-1', generation, cwd: directory });
    journal.append({ t: 'cwd', cursor: 7, term: 'shell-1', generation, cwd: '/tmp' });
    journal.append({
      t: 'env-delta',
      cursor: 8,
      term: 'shell-2',
      generation: randomUUID(),
      delta: { op: 'unset', name: 'A' },
    });
    expect(journal.read(1).events.map((e) => e.cursor)).toEqual([2, 3, 4, 7, 8]);
    await journal.flush();
    expect(readRuntimeJournal(directory, identity).events).toEqual(journal.read(1).events);
  });

  it('reclaims coalesced byte/count space while keeping earlier evidence on overflow', () => {
    const { journal } = fixture({ maxEvents: 1, maxBytes: 1024 });
    const generation = randomUUID();
    const delta = (cursor: number, value: string): RuntimeRetainedEvent => ({
      t: 'env-delta',
      cursor,
      term: 'agent',
      generation,
      delta: { op: 'set', name: 'A', value },
    });
    for (let cursor = 1; cursor <= 1000; cursor++)
      expect(journal.append(delta(cursor, 'small'))).toBe(true);
    expect(journal.read(0)).toMatchObject({ gap: false, events: [delta(1000, 'small')] });
    expect(journal.append(delta(1001, 'x'.repeat(1024)))).toBe(false);
    expect(journal.read(0)).toMatchObject({ gap: true, events: [delta(1000, 'small')] });
  });

  it('treats environment purge and capture policy changes as observation barriers', () => {
    const { journal } = fixture();
    const generation = randomUUID();
    const delta = (cursor: number): RuntimeRetainedEvent => ({
      t: 'env-delta',
      cursor,
      term: 'agent',
      generation,
      delta: { op: 'set', name: 'A', value: `${cursor}` },
    });
    journal.append(delta(1));
    journal.append({ t: 'clear-env', cursor: 2 });
    journal.append(delta(3));
    journal.append({ t: 'capture-env', cursor: 4, enabled: false });
    journal.append({ t: 'capture-env', cursor: 5, enabled: true });
    journal.append(delta(6));
    expect(journal.read(0).events.map((e) => e.cursor)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('keeps reserved outcome space when unrelated essential traffic fills the journal', async () => {
    const { journal } = fixture({ maxEvents: 3 });
    const reservation = journal.reserve(1024, 2)!;
    expect(reservation).not.toBeNull();
    reservation.append(event(1));
    expect(journal.append(event(2))).toBe(true);
    expect(journal.append(event(3))).toBe(false);
    reservation.append(event(4));
    reservation.release();
    reservation.release();
    expect(journal.read(0).events.map((event) => event.cursor)).toEqual([1, 2, 4]);
    expect(journal.read(0).gap).toBe(true);
    expect(journal.reserve(10, 1)).toBeNull();
    expect(() => reservation.append(event(5))).toThrow(/closed/);
    await journal.flush();
  });

  it('retains ordered essential events privately until the daemon acknowledges its committed cursor', async () => {
    const { directory, identity, journal } = fixture();
    const first = event(2);
    const last = event(90); // Output cursors between essential observations need no retention.
    journal.append(first);
    journal.append(last);
    expect(await journal.flush()).toBe(true);
    expect(statSync(join(directory, 'events.json')).mode & 0o777).toBe(0o600);
    expect(readRuntimeJournal(directory, identity).events).toEqual([first, last]);
    expect(journal.read(0)).toMatchObject({
      events: [first, last],
      through: 90,
      gap: false,
      more: false,
    });
    journal.acknowledge(2);
    expect(await journal.flush()).toBe(true);
    expect(readRuntimeJournal(directory, identity)).toMatchObject({
      acknowledged: 2,
      events: [last],
    });
    expect(journal.read(0).gap).toBe(true);
    expect(journal.read(2).gap).toBe(false);
    journal.acknowledge(2);
    expect(journal.status().persistence_pending).toBe(false);
    expect(() => journal.acknowledge(91)).toThrow(/cursor/);
    expect(() => journal.append(event(90))).toThrow(/advance/);
    expect(() => journal.read(-1)).toThrow(/cursor/);
  });

  it('paginates without acknowledging unread history and isolates returned values', () => {
    const { journal } = fixture();
    for (let cursor = 1; cursor <= RUNTIME_LIMITS.eventPage + 1; cursor++)
      journal.append(event(cursor));
    const first = journal.read(0);
    expect(first.events).toHaveLength(RUNTIME_LIMITS.eventPage);
    expect(first.through).toBe(RUNTIME_LIMITS.eventPage);
    expect(first.more).toBe(true);
    first.events[0]!.cursor = 1000;
    expect(journal.read(0).events[0]!.cursor).toBe(1);
    const last = journal.read(first.through);
    expect(last.events).toHaveLength(1);
    expect(last.more).toBe(false);
    expect(journal.status().acknowledged).toBe(0);
  });

  it('bounds count without evicting unacknowledged events and persists an irreversible gap', async () => {
    const { journal, directory, identity } = fixture({ maxEvents: 2 });
    const first = event(1);
    const second = event(3);
    expect(journal.append(first)).toBe(true);
    expect(journal.append(second)).toBe(true);
    expect(journal.append(event(5))).toBe(false);
    expect(journal.append(event(6))).toBe(false);
    expect(journal.read(0)).toMatchObject({ events: [first, second], gap: true, through: 6 });
    expect(journal.read(6).gap).toBe(true);
    expect(() => journal.acknowledge(6)).toThrow(/incomplete/);
    await journal.close();
    expect(readRuntimeJournal(directory, identity)).toMatchObject({
      lost_through: 6,
      events: [first, second],
    });
    expect(() => journal.append(event(7))).toThrow(/closed/);
  });

  it('bounds encoded bytes independently of event count and recovers space after acknowledgement', async () => {
    const { journal, directory } = fixture({ maxBytes: 1024 });
    let cursor = 0;
    journal.append(event(++cursor));
    journal.acknowledge(cursor);
    expect(journal.append(event(++cursor))).toBe(true);
    while (journal.append(event(++cursor))) {
      /* Reach the byte bound. */
    }
    expect(journal.read(cursor).gap).toBe(true);
    expect(cursor).toBeLessThan(10);
    await journal.flush();
    expect(readFileSync(join(directory, 'events.json')).length).toBeLessThanOrEqual(1024);
  });

  it('keeps observations in memory during disk failure and backs off without queueing writes', async () => {
    vi.useFakeTimers();
    const write = vi
      .fn<(file: string, record: RuntimeJournalRecord) => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error('Disk full'), { code: 'ENOSPC' }))
      .mockResolvedValue(undefined);
    const { journal } = fixture({ write });
    const first = event(1);
    journal.append(first);
    expect(await journal.flush()).toBe(false);
    for (let cursor = 2; cursor <= 10; cursor++) journal.append(event(cursor));
    expect(await journal.flush()).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(journal.read(0)).toMatchObject({ gap: false, journal: { persistence_pending: true } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]![1].events).toHaveLength(10);
    expect(journal.status().persistence_pending).toBe(false);
  });

  it('coalesces changes while a write is stalled and never reports a newer revision as durable', async () => {
    let release!: () => void;
    const write = vi.fn(async (_file: string, _record: RuntimeJournalRecord) => {});
    write.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { journal } = fixture({ write });
    journal.append(event(1));
    const saving = journal.flush();
    for (let cursor = 2; cursor <= 20; cursor++) journal.append(event(cursor));
    expect(write).toHaveBeenCalledTimes(1);
    expect(journal.read(0).events).toHaveLength(20);
    release();
    expect(await saving).toBe(false);
    expect(journal.status().persistence_pending).toBe(true);
    expect(await journal.flush()).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0]![1].events).toHaveLength(1);
    expect(write.mock.calls[1]![1].events).toHaveLength(20);
  });

  it('rejects foreign identities and corrupt ordering in retained records', async () => {
    const { journal, directory, identity } = fixture();
    journal.append(event(4));
    await journal.flush();
    expect(() => readRuntimeJournal(directory, { ...identity, incarnation: randomUUID() })).toThrow(
      /identity/,
    );
    const record = readRuntimeJournal(directory, identity);
    expect(
      runtimeJournalSchema.safeParse({ ...record, events: [event(4), event(2)] }).success,
    ).toBe(false);
    expect(runtimeJournalSchema.safeParse({ ...record, acknowledged: 5 }).success).toBe(false);
    expect(runtimeJournalSchema.safeParse({ ...record, lost_through: 5 }).success).toBe(false);
    atomicPrivateJson(join(directory, 'events.json'), { ...record, events: [event(5)] });
    expect(() => readRuntimeJournal(directory, identity)).toThrow(/ordered/);
  });
});
