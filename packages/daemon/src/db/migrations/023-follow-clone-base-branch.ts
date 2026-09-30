/**
 * Default every repository to the clone's current branch, including existing
 * saved defaults. Rebuild to replace the SQLite default as well; ids and other
 * settings stay intact. This runs once, so later explicit defaults persist.
 * Existing session placements keep their recorded base and worktree branches.
 */
export const migration023 = {
  version: 23,
  name: 'follow-clone-base-branch',
  sql: `
CREATE TABLE repos_new (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  default_base_branch TEXT NOT NULL DEFAULT '',
  onboarding_notes TEXT,
  fetch_enabled INTEGER NOT NULL DEFAULT 1,
  last_fetched_at TEXT
);
INSERT INTO repos_new (id, path, default_base_branch, onboarding_notes, fetch_enabled, last_fetched_at)
  SELECT id, path, '', onboarding_notes, fetch_enabled, last_fetched_at FROM repos;

DROP TABLE repos;
ALTER TABLE repos_new RENAME TO repos;
`,
} as const;
