/** Bounded host observations are committed with their originating session/audit writes. */
export const migration047 = {
  version: 47,
  name: 'huddle-session-feed',
  sql: `
CREATE TABLE huddle_session_feed_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  epoch TEXT NOT NULL,
  head INTEGER NOT NULL DEFAULT 0 CHECK (head >= 0),
  floor INTEGER NOT NULL DEFAULT 0 CHECK (floor >= 0 AND floor <= head)
);
INSERT INTO huddle_session_feed_state(singleton, epoch) VALUES (1, lower(hex(randomblob(16))));
CREATE TABLE huddle_session_feed (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  worktree TEXT NOT NULL,
  session_kind TEXT NOT NULL,
  event TEXT NOT NULL,
  source TEXT NOT NULL,
  previous_status TEXT,
  status TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_object(
    'sequence', sequence, 'profileId', profile_id, 'projectId', project_id,
    'sessionId', session_id, 'worktree', worktree, 'sessionKind', session_kind,
    'event', event, 'source', source, 'previousStatus', previous_status,
    'status', status, 'observedAt', observed_at) AS BLOB))) STORED
);
CREATE INDEX huddle_session_feed_scope ON huddle_session_feed(profile_id, project_id, sequence);
CREATE TRIGGER huddle_session_feed_trim AFTER INSERT ON huddle_session_feed
BEGIN
  UPDATE huddle_session_feed_state SET head = NEW.sequence WHERE singleton = 1;
  DELETE FROM huddle_session_feed WHERE sequence <= NEW.sequence - 4096;
  -- Oversize source metadata becomes an explicit gap, never an unbounded record
  -- and never a reason to roll back the originating session operation.
  DELETE FROM huddle_session_feed WHERE sequence = NEW.sequence
    AND (bytes > 8192 OR length(worktree) > 4096 OR length(worktree) = 0);
END;
CREATE TRIGGER huddle_session_feed_deleted AFTER DELETE ON huddle_session_feed
BEGIN
  UPDATE huddle_session_feed_state SET floor = MAX(floor, OLD.sequence) WHERE singleton = 1;
END;
CREATE TRIGGER huddle_session_feed_created AFTER INSERT ON sessions
BEGIN
  INSERT INTO huddle_session_feed(profile_id, project_id, session_id, worktree, session_kind,
    event, source, previous_status, status, observed_at)
  SELECT p.profile_id, NEW.project_id, NEW.id, NEW.canonical_worktree_path, NEW.kind,
    'created', 'placement', NULL, NEW.status, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM projects p WHERE p.id = NEW.project_id;
END;
CREATE TRIGGER huddle_session_feed_status AFTER UPDATE OF status ON sessions
WHEN NEW.status != OLD.status
BEGIN
  INSERT INTO huddle_session_feed(profile_id, project_id, session_id, worktree, session_kind,
    event, source, previous_status, status, observed_at)
  SELECT p.profile_id, NEW.project_id, NEW.id, NEW.canonical_worktree_path, NEW.kind,
    'status', 'status', OLD.status, NEW.status, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM projects p WHERE p.id = NEW.project_id;
END;
CREATE TRIGGER huddle_session_feed_audit AFTER INSERT ON events
WHEN NEW.type IN ('resumed', 'interrupted', 'exited', 'killed', 'archived', 'unarchived', 'spawn_failed')
BEGIN
  INSERT INTO huddle_session_feed(profile_id, project_id, session_id, worktree, session_kind,
    event, source, previous_status, status, observed_at)
  SELECT p.profile_id, s.project_id, s.id, s.canonical_worktree_path, s.kind,
    NEW.type, 'audit', NULL, s.status, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = NEW.session_id;
END;
`,
};
