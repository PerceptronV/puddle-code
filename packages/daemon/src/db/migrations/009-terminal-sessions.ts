/**
 * Terminal sessions (SPEC §4): a session can now be a plain shell PTY with no
 * coding agent and no account. That makes `account_id` and `agent_type`
 * nullable and adds a `kind` discriminator ('agent' | 'terminal'). SQLite
 * cannot drop a column's NOT NULL in place, so the sessions table is rebuilt
 * (the 002 pattern); every existing row copies across as an 'agent' session.
 * Runs with foreign_keys OFF (see db.ts migrate()).
 */
export const migration009 = {
  version: 9,
  name: 'terminal-sessions',
  sql: `
CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  account_id INTEGER REFERENCES accounts(id),   -- nullable: terminal sessions have no account
  worktree_path TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  branch TEXT NOT NULL,
  agent_type TEXT,                              -- nullable: terminal sessions have no agent
  agent_session_ref TEXT,
  title TEXT,
  status TEXT NOT NULL,
  skip_permissions INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT,
  separate_branch INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'agent'
);
INSERT INTO sessions_new (id, project_id, account_id, worktree_path, base_branch, branch,
    agent_type, agent_session_ref, title, status, skip_permissions, created_at, updated_at,
    last_activity_at, separate_branch)
  SELECT id, project_id, account_id, worktree_path, base_branch, branch,
    agent_type, agent_session_ref, title, status, skip_permissions, created_at, updated_at,
    last_activity_at, separate_branch
  FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX idx_sessions_project ON sessions(project_id);
CREATE INDEX idx_sessions_status ON sessions(status);
`,
};
