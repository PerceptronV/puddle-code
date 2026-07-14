/**
 * Profiles move from integer ids to 10-hex-char ids, matching projects:
 * opaque handles everywhere, with names demoted to display labels. Account
 * config-dir paths swap their `/profiles/<name>/` segment for the new id —
 * the daemon renames the physical directories to match at the next boot
 * (see profile-dirs.ts). Runs with foreign_keys OFF (see db.ts migrate()).
 */
export const migration004 = {
  version: 4,
  name: 'profile-hex-ids',
  sql: `
CREATE TEMP TABLE profile_id_map AS
  SELECT id AS old_id, name, lower(hex(randomblob(5))) AS new_id FROM profiles;

CREATE TABLE profiles_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  branch_prefix TEXT NOT NULL DEFAULT '',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
INSERT INTO profiles_new
  SELECT m.new_id, p.name, p.branch_prefix, p.settings, p.created_at
  FROM profiles p JOIN profile_id_map m ON m.old_id = p.id;

CREATE TABLE accounts_new (
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  agent_type TEXT NOT NULL,
  label TEXT NOT NULL,
  config_dir TEXT NOT NULL,
  skip_permissions_default INTEGER NOT NULL DEFAULT 0,
  logged_in INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(profile_id, agent_type, label)
);
INSERT INTO accounts_new
  SELECT a.id, m.new_id, a.agent_type, a.label,
         replace(a.config_dir, '/profiles/' || m.name || '/', '/profiles/' || m.new_id || '/'),
         a.skip_permissions_default, a.logged_in, a.created_at
  FROM accounts a JOIN profile_id_map m ON m.old_id = a.profile_id;

CREATE TABLE projects_new (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, name)
);
INSERT INTO projects_new
  SELECT p.id, m.new_id, p.repo_id, p.name, p.created_at, p.updated_at
  FROM projects p JOIN profile_id_map m ON m.old_id = p.profile_id;

CREATE TABLE project_states_new (
  project_id TEXT NOT NULL REFERENCES projects(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  ui_state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, profile_id)
);
INSERT INTO project_states_new
  SELECT ps.project_id, m.new_id, ps.ui_state, ps.updated_at
  FROM project_states ps JOIN profile_id_map m ON m.old_id = ps.profile_id;

CREATE TABLE prompts_new (
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
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
  SELECT p.id, m.new_id, p.title, p.body, p.tags, p.project_id, p.agent_type,
         p.use_count, p.last_used_at, p.created_at, p.updated_at
  FROM prompts p JOIN profile_id_map m ON m.old_id = p.profile_id;

DROP TABLE prompts;
DROP TABLE project_states;
DROP TABLE projects;
DROP TABLE accounts;
DROP TABLE profiles;
ALTER TABLE profiles_new RENAME TO profiles;
ALTER TABLE accounts_new RENAME TO accounts;
ALTER TABLE projects_new RENAME TO projects;
ALTER TABLE project_states_new RENAME TO project_states;
ALTER TABLE prompts_new RENAME TO prompts;
DROP TABLE profile_id_map;

CREATE INDEX idx_accounts_profile ON accounts(profile_id);
CREATE INDEX idx_projects_profile ON projects(profile_id);
`,
};
