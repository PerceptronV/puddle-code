export const migration001 = {
  version: 1,
  name: 'initial',
  sql: `
CREATE TABLE profiles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  branch_prefix TEXT NOT NULL DEFAULT '',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id),
  agent_type TEXT NOT NULL,
  label TEXT NOT NULL,
  config_dir TEXT NOT NULL,
  skip_permissions_default INTEGER NOT NULL DEFAULT 0,
  logged_in INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(profile_id, agent_type, label)
);

CREATE TABLE repos (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  default_base_branch TEXT NOT NULL DEFAULT 'main',
  onboarding_notes TEXT,
  fetch_enabled INTEGER NOT NULL DEFAULT 1,
  last_fetched_at TEXT
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id),
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, name)
);

CREATE TABLE project_states (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  client_id TEXT NOT NULL,
  ui_state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, client_id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
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

CREATE TABLE prompts (
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id),
  title TEXT,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  project_id INTEGER REFERENCES projects(id),
  agent_type TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  type TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_accounts_profile ON accounts(profile_id);
CREATE INDEX idx_projects_profile ON projects(profile_id);
CREATE INDEX idx_sessions_project ON sessions(project_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_events_session ON events(session_id);
`,
};
