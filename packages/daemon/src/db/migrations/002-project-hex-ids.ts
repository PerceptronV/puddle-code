/**
 * Projects move from integer ids to 10-hex-char ids so URLs are stable,
 * unguessable-ish handles (/project/a1b2c3d4e5) like sessions already are.
 * SQLite cannot retype a primary key, so projects and every table referencing
 * it are rebuilt; existing rows get fresh hex ids via a temporary map.
 * Runs with foreign_keys OFF (see db.ts migrate()).
 */
export const migration002 = {
  version: 2,
  name: 'project-hex-ids',
  sql: `
CREATE TEMP TABLE project_id_map AS
  SELECT id AS old_id, lower(hex(randomblob(5))) AS new_id FROM projects;

CREATE TABLE projects_new (
  id TEXT PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id),
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, name)
);
INSERT INTO projects_new
  SELECT m.new_id, p.profile_id, p.repo_id, p.name, p.created_at, p.updated_at
  FROM projects p JOIN project_id_map m ON m.old_id = p.id;

CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  worktree_path TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  branch TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  agent_session_ref TEXT,
  title TEXT,
  status TEXT NOT NULL,
  skip_permissions INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT
);
INSERT INTO sessions_new
  SELECT s.id, m.new_id, s.account_id, s.worktree_path, s.base_branch, s.branch,
         s.agent_type, s.agent_session_ref, s.title, s.status, s.skip_permissions,
         s.created_at, s.updated_at, s.last_activity_at
  FROM sessions s JOIN project_id_map m ON m.old_id = s.project_id;

CREATE TABLE project_states_new (
  project_id TEXT NOT NULL REFERENCES projects(id),
  client_id TEXT NOT NULL,
  ui_state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, client_id)
);
INSERT INTO project_states_new
  SELECT m.new_id, ps.client_id, ps.ui_state, ps.updated_at
  FROM project_states ps JOIN project_id_map m ON m.old_id = ps.project_id;

CREATE TABLE prompts_new (
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id),
  title TEXT,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  project_id TEXT REFERENCES projects(id),
  agent_type TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO prompts_new
  SELECT p.id, p.profile_id, p.title, p.body, p.tags, m.new_id, p.agent_type,
         p.use_count, p.last_used_at, p.created_at, p.updated_at
  FROM prompts p LEFT JOIN project_id_map m ON m.old_id = p.project_id;

DROP TABLE prompts;
DROP TABLE project_states;
DROP TABLE sessions;
DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;
ALTER TABLE sessions_new RENAME TO sessions;
ALTER TABLE project_states_new RENAME TO project_states;
ALTER TABLE prompts_new RENAME TO prompts;
DROP TABLE project_id_map;

CREATE INDEX idx_projects_profile ON projects(profile_id);
CREATE INDEX idx_sessions_project ON sessions(project_id);
CREATE INDEX idx_sessions_status ON sessions(status);
`,
};
