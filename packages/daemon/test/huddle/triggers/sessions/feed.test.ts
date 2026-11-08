import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { HUDDLE_SESSION_FEED_LIMITS, huddleSessionFeedPageSchema } from '@puddle/shared';
import { sessionFeedFixture } from '../../../helpers/huddle/session-feed.js';
import { HuddleSessionFeed } from '../../../../src/huddle/triggers/sessions/feed.js';
import { openDatabase } from '../../../../src/db/db.js';
import { ProfileStore } from '../../../../src/db/stores/profiles.js';
const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup()),
);
function fixture() {
  const f = sessionFeedFixture();
  cleanups.push(f.cleanup);
  return f;
}
it('records changed statuses and lifecycle audits atomically, without treating status as completion', () => {
  const f = fixture(),
    baseline = f.feed.read(f.scope, null).cursor;
  f.sessions.setStatus(f.session.id, 'running');
  f.sessions.setStatus(f.session.id, 'running');
  f.sessions.setStatus(f.session.id, 'waiting_input');
  f.events.record(f.session.id, 'created', { secret: 'do not copy' });
  f.events.record(f.session.id, 'native_session_end', { secret: 'do not copy' });
  f.events.record(f.session.id, 'exited', { secret: 'do not copy' });
  expect(f.events.recordOnce(f.session.id, 'resumed', { exact: 1 })).toBe(true);
  expect(f.events.recordOnce(f.session.id, 'resumed', { exact: 1 })).toBe(false);
  const page = f.feed.read(f.scope, baseline);
  expect(page.state).toBe('events');
  if (page.state !== 'events') throw new Error('missing events');
  expect(page.records.map((row) => row.event)).toEqual(['status', 'status', 'exited', 'resumed']);
  expect(page.records[1]).toMatchObject({
    previousStatus: 'running',
    status: 'waiting_input',
    source: 'status',
  });
  expect(JSON.stringify(page)).not.toContain('secret');
  expect(JSON.stringify(page)).not.toContain('turn');
  huddleSessionFeedPageSchema.parse(page);
  expect(() =>
    f.db.transaction(() => {
      f.sessions.setStatus(f.session.id, 'archived');
      f.events.record(f.session.id, 'archived');
      throw new Error('rollback');
    })(),
  ).toThrow('rollback');
  expect(f.sessions.get(f.session.id).status).toBe('waiting_input');
  expect(f.feed.read(f.scope, page.cursor)).toMatchObject({
    state: 'events',
    records: [],
    cursor: page.cursor,
  });
});
it('filters historical scope, worktrees, sessions, kinds and events without leaking unrelated observations', () => {
  const f = fixture(),
    baseline = f.feed.read(f.scope, null).cursor;
  const other = new ProfileStore(f.db).create({ name: 'other', branch_prefix: '' });
  const foreign = f.projects.create({ profile_id: other.id, repo_id: f.repo.id, name: 'foreign' });
  f.create(foreign.id);
  f.create(f.project.id, '/other/worktree');
  const chosen = f.create();
  f.sessions.setStatus(chosen.id, 'running');
  f.events.record(chosen.id, 'resumed');
  const page = f.feed.read({ ...f.scope, sessionId: chosen.id, events: ['resumed'] }, baseline);
  expect(page.state).toBe('events');
  if (page.state !== 'events') throw new Error('missing events');
  expect(page.records).toHaveLength(1);
  expect(page.records[0]!.sessionId).toBe(chosen.id);
  for (const extra of [
    { excludeSessionId: chosen.id },
    { kinds: ['agent'] as const },
    { projectId: foreign.id },
    { sessionId: randomUUID() },
  ]) {
    const selected = {
      ...f.scope,
      sessionId: chosen.id,
      ...extra,
      kinds: [...(extra.kinds ?? f.scope.kinds)],
    };
    expect(f.feed.read(selected, baseline)).toMatchObject({
      state: 'events',
      records: [],
      cursor: page.cursor,
    });
  }
});
it('bounds count and bytes per page, advances across filtered records and keeps cursors after reopen', () => {
  const f = fixture(),
    worktree = '/' + 'x'.repeat(3999),
    session = f.create(f.project.id, worktree);
  const scope = { ...f.scope, worktree },
    baseline = f.feed.read(scope, null).cursor;
  f.db.transaction(() => {
    for (let i = 0; i < 140; i++) f.events.record(session.id, 'resumed');
  })();
  let cursor = baseline;
  const ids = new Set<number>();
  let pages = 0;
  for (;;) {
    const page = f.feed.read(scope, cursor);
    huddleSessionFeedPageSchema.parse(page);
    if (page.state !== 'events') throw new Error('unexpected gap');
    if (!page.records.length) break;
    expect(page.records.length).toBeLessThan(HUDDLE_SESSION_FEED_LIMITS.page);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
      HUDDLE_SESSION_FEED_LIMITS.pageBytes,
    );
    expect(page.cursor.sequence).toBeGreaterThan(cursor.sequence);
    for (const row of page.records) {
      expect(ids.has(row.sequence)).toBe(false);
      ids.add(row.sequence);
    }
    cursor = page.cursor;
    pages++;
  }
  expect(ids.size).toBe(140);
  expect(pages).toBeGreaterThan(2);
  f.db.close();
  const reopened = openDatabase(f.file);
  try {
    expect(new HuddleSessionFeed(reopened).read(scope, cursor)).toMatchObject({
      state: 'events',
      records: [],
      cursor,
    });
  } finally {
    reopened.close();
  }
});
it('reports bounded retention, changed epochs and impossible cursors as gaps without silently rebasing', () => {
  const f = fixture(),
    baseline = f.feed.read(f.scope, null).cursor;
  f.db.transaction(() => {
    for (let i = 0; i < HUDDLE_SESSION_FEED_LIMITS.records + 5; i++)
      f.events.record(f.session.id, 'resumed');
  })();
  expect(
    f.db.prepare('SELECT COUNT(*) AS count, MAX(bytes) AS bytes FROM huddle_session_feed').get(),
  ).toMatchObject({ count: HUDDLE_SESSION_FEED_LIMITS.records });
  const gap = f.feed.read(f.scope, baseline);
  expect(gap).toMatchObject({ state: 'gap', reason: 'retention' });
  if (gap.state !== 'gap') throw new Error('missing retention gap');
  const retained = f.feed.read(f.scope, { ...gap.cursor, sequence: gap.floor });
  expect(retained.state).toBe('events');
  if (retained.state !== 'events') throw new Error('missing retained page');
  expect(retained.records).toHaveLength(HUDDLE_SESSION_FEED_LIMITS.page);
  expect(retained.cursor.sequence).toBe(retained.records.at(-1)!.sequence);
  huddleSessionFeedPageSchema.parse(retained);
  expect(f.feed.read(f.scope, { ...gap.cursor, epoch: 'f'.repeat(32) })).toMatchObject({
    state: 'gap',
    reason: 'epoch',
  });
  expect(f.feed.read(f.scope, { ...gap.cursor, sequence: gap.cursor.sequence + 1 })).toMatchObject({
    state: 'gap',
    reason: 'ahead',
  });
  // Even an unexpected deletion advances the conservative loss floor.
  f.db.prepare('DELETE FROM huddle_session_feed').run();
  expect(f.feed.read(f.scope, baseline)).toMatchObject({
    state: 'gap',
    reason: 'retention',
    floor: gap.cursor.sequence,
  });
  f.events.record(f.session.id, 'resumed');
  const next = f.feed.read(f.scope, gap.cursor);
  expect(next.state).toBe('events');
  if (next.state !== 'events') throw new Error('missing events');
  expect(next.records[0]!.sequence).toBeGreaterThan(gap.cursor.sequence);
});
it('turns oversized observation metadata into a gap without failing its session mutation', () => {
  const f = fixture(),
    baseline = f.feed.read(f.scope, null).cursor;
  f.db
    .prepare('UPDATE sessions SET canonical_worktree_path = ? WHERE id = ?')
    .run('/' + '\u0001'.repeat(2000), f.session.id);
  f.sessions.setStatus(f.session.id, 'running');
  expect(f.sessions.get(f.session.id).status).toBe('running');
  expect(f.feed.read(f.scope, baseline)).toMatchObject({ state: 'gap', reason: 'retention' });
  expect(f.db.prepare('SELECT MAX(bytes) AS bytes FROM huddle_session_feed').get()).toEqual(
    expect.objectContaining({ bytes: expect.any(Number) }),
  );
  expect(
    (f.db.prepare('SELECT MAX(bytes) AS bytes FROM huddle_session_feed').get() as { bytes: number })
      .bytes,
  ).toBeLessThanOrEqual(HUDDLE_SESSION_FEED_LIMITS.rowBytes);
});
