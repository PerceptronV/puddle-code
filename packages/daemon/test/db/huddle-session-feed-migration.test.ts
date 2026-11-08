import { join } from 'node:path';
import { expect, it } from 'vitest';
import { sessionFeedFixture } from '../helpers/huddle/session-feed.js';
import { writeHistoricalDatabase } from '../helpers/db/historical.js';
import { openDatabase } from '../../src/db/db.js';
import { DATABASE_SCHEMA_VERSION } from '../../src/db/migrations/index.js';
import { SessionStore } from '../../src/db/stores/sessions.js';
import { HuddleSessionFeed } from '../../src/huddle/triggers/sessions/feed.js';

it('migrates schema 46 without backfilling observations or changing session/audit history', () => {
  const f = sessionFeedFixture(),
    file = join(f.home, 'old.sqlite');
  try {
    f.events.record(f.session.id, 'resumed');
    writeHistoricalDatabase(f.db, file, 46);
    const db = openDatabase(file);
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(DATABASE_SCHEMA_VERSION);
      expect(new SessionStore(db).get(f.session.id)).toEqual(f.sessions.get(f.session.id));
      expect(db.prepare('SELECT * FROM events').all()).toEqual(
        f.db.prepare('SELECT * FROM events').all(),
      );
      const feed = new HuddleSessionFeed(db),
        baseline = feed.read(f.scope, null).cursor;
      expect(baseline.sequence).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS count FROM huddle_session_feed').get()).toEqual({
        count: 0,
      });
      new SessionStore(db).setStatus(f.session.id, 'running');
      expect(feed.read(f.scope, baseline)).toMatchObject({
        state: 'events',
        records: [{ event: 'status', previousStatus: 'starting', status: 'running' }],
      });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  } finally {
    f.cleanup();
  }
});
