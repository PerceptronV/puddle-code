import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as files from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { allRollouts, cachedRolloutPath } from '../../src/agents/codex/rollout.js';
import { codex } from '../../src/agents/codex/index.js';
import type { Account } from '@puddle/shared';
import { openDatabase } from '../../src/db/db.js';
import { fixture } from '../helpers/daemon-fixtures.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(actual.readdir),
    open: vi.fn(actual.open),
    stat: vi.fn(actual.stat),
  };
});

function record(value: unknown) {
  if (process.env.PUDDLE_PROFILE_OUTPUT)
    appendFileSync(process.env.PUDDLE_PROFILE_OUTPUT, JSON.stringify(value) + '\n');
}

it('measures discovery of a long synthetic dated history and active append', async () => {
  const root = mkdtempSync(join(tmpdir(), 'puddle-catalogue-work-'));
  onTestFinished(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });
  const paths: string[] = [];
  for (let day = 1; day <= 20; day++) {
    const bucket = join(root, 'sessions', '2026', '01', String(day).padStart(2, '0'));
    mkdirSync(bucket, { recursive: true });
    for (let item = 0; item < 50; item++) {
      const id = `synthetic-${day}-${item}`;
      const path = join(bucket, `rollout-${id}.jsonl`);
      writeFileSync(
        path,
        JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/synthetic/project' } }) + '\n',
      );
      paths.push(path);
    }
  }
  const enumeration = vi.mocked(files.readdir);
  const open = vi.mocked(files.open);
  for (const phase of ['cold', 'unchanged', 'append']) {
    enumeration.mockClear();
    open.mockClear();
    if (phase === 'append') appendFileSync(paths[0]!, '{"type":"synthetic-output"}\n');
    const started = performance.now();
    const rows = await allRollouts(root);
    const elapsedMs = performance.now() - started;
    let filesEnumerated = 0;
    for (const result of enumeration.mock.results) {
      if (result.type !== 'return') continue;
      for (const entry of await result.value)
        if (typeof entry === 'object' && 'isFile' in entry && entry.isFile()) filesEnumerated++;
    }
    record({
      phase,
      rows: rows.length,
      directoryReads: enumeration.mock.calls.length,
      filesEnumerated,
      headerReads: open.mock.calls.length,
      elapsedMs,
    });
    expect(rows).toHaveLength(1000);
    expect(open.mock.calls.length).toBe(phase === 'cold' ? 1000 : 0);
  }
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let concurrent = 0,
    maximum = 0;
  vi.mocked(files.stat).mockImplementation(async (path) => {
    concurrent++;
    maximum = Math.max(maximum, concurrent);
    try {
      return await actual.stat(path);
    } finally {
      concurrent--;
    }
  });
  const started = performance.now();
  const rows = await codex.conversationDiscovery!.discover({ config_dir: root } as Account);
  record({
    phase: 'full-codex-discovery',
    rows: rows.length,
    statCalls: vi.mocked(files.stat).mock.calls.length,
    maximumConcurrentStats: maximum,
    elapsedMs: performance.now() - started,
  });
  expect(rows).toHaveLength(1000);
  expect(maximum).toBe(32);
  expect(rows.every((row) => row.updatedAt !== null)).toBe(true);
  const renamed = join(root, 'sessions', '2026', '01', '01', 'rollout-renamed.jsonl');
  await files.rename(paths[0]!, renamed);
  expect(await allRollouts(root)).toHaveLength(1000);
  expect(cachedRolloutPath(root, 'synthetic-1-0')).toBe(renamed);
  await files.unlink(paths[1]!);
  expect(await allRollouts(root)).toHaveLength(999);
  expect(cachedRolloutPath(root, 'synthetic-1-1')).toBeNull();
  const oldBucket = join(root, 'sessions', '2025', '12', '01');
  mkdirSync(oldBucket, { recursive: true });
  writeFileSync(
    join(oldBucket, 'rollout-historical.jsonl'),
    JSON.stringify({
      type: 'session_meta',
      payload: { id: 'historical', cwd: '/synthetic/project' },
    }) + '\n',
  );
  expect((await allRollouts(root)).some((row) => row.id === 'historical')).toBe(true);
});

it('measures unchanged metadata and presence writes separately', () => {
  const f = fixture();
  const db = openDatabase(f.paths.dbFile, { migrate: false });
  onTestFinished(() => db.close());
  const store = f.stores.conversations;
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    ref: `synthetic-${i}`,
    cwd: f.repoPath,
    title: 'Synthetic title',
    parentRef: null,
    createdAt: null,
    updatedAt: null,
  }));
  store.upsertMany(f.ids.profile, 'fake', f.ids.account, rows, '2026-01-01T00:00:00.000Z');
  db.exec(`CREATE TABLE work_counts (metadata INTEGER, presence INTEGER);
    INSERT INTO work_counts VALUES(0,0);
    CREATE TRIGGER count_metadata AFTER UPDATE OF native_cwd,native_title,parent_conversation_id,native_created_at,native_updated_at,preferred_account_id ON agent_conversations BEGIN
      UPDATE work_counts SET metadata=metadata+1;
    END;
    CREATE TRIGGER count_presence AFTER UPDATE OF last_seen_at ON agent_conversations BEGIN
      UPDATE work_counts SET presence=presence+1;
    END;`);
  const started = performance.now();
  store.upsertMany(f.ids.profile, 'fake', f.ids.account, rows, '2026-01-02T00:00:00.000Z');
  const elapsedMs = performance.now() - started;
  const counts = db.prepare('SELECT * FROM work_counts').get();
  record({ phase: 'unchanged-metadata', rows: rows.length, counts, elapsedMs });
  expect(counts).toEqual({ metadata: 0, presence: 1000 });
  store.upsertMany(
    f.ids.profile,
    'fake',
    f.ids.account,
    [{ ...rows[0]!, title: 'Renamed' }],
    '2026-01-03T00:00:00.000Z',
  );
  expect(db.prepare('SELECT * FROM work_counts').get()).toEqual({ metadata: 1, presence: 1001 });
});

it('preserves omitted fields, explicit clearing, delayed parents and newer observations in a batch', () => {
  const f = fixture();
  const store = f.stores.conversations;
  const observe = (
    rows: Parameters<typeof store.upsertMany>[3],
    seenAt = '2026-01-01T00:00:00.000Z',
  ) => store.upsertMany(f.ids.profile, 'fake', f.ids.account, rows, seenAt);
  const [child] = observe([{ ref: 'child', cwd: f.repoPath, title: 'Child', parentRef: 'parent' }]);
  const parentId = child!.conversation.parent_conversation_id;
  expect(parentId).not.toBeNull();
  observe([{ ref: 'parent', cwd: f.repoPath, title: 'Arrived later' }]);
  expect(store.get(parentId!)?.native_title).toBe('Arrived later');
  const [omitted] = observe([{ ref: 'child', cwd: f.repoPath }], '2099-01-01T00:00:00.000Z');
  expect(omitted!.conversation).toMatchObject({
    native_title: 'Child',
    parent_conversation_id: parentId,
  });
  const [cleared] = observe([{ ref: 'child', cwd: f.repoPath, title: null, parentRef: null }]);
  expect(cleared!.conversation).toMatchObject({
    native_title: null,
    parent_conversation_id: null,
    last_seen_at: '2099-01-01T00:00:00.000Z',
  });
});

it('rolls back a failed metadata batch before publishing a partial observation', () => {
  const f = fixture();
  const store = f.stores.conversations;
  store.upsert(f.ids.profile, 'fake', f.ids.account, {
    ref: 'existing',
    cwd: f.repoPath,
    title: 'Original',
  });
  expect(() =>
    store.upsertMany(
      f.ids.profile,
      'fake',
      f.ids.account,
      [
        { ref: 'existing', cwd: f.repoPath, title: 'Partial rename' },
        { ref: 'invalid', cwd: null as unknown as string },
      ],
      '2026-01-01T00:00:00.000Z',
    ),
  ).toThrow();
  expect(store.getByRef(f.ids.profile, 'fake', 'existing')?.native_title).toBe('Original');
  expect(store.getByRef(f.ids.profile, 'fake', 'invalid')).toBeUndefined();
});
