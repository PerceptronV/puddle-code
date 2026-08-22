/**
 * Native conversations become durable, profile-scoped catalogue rows. Session
 * rows are Puddle placements: they retain their UUID, project/worktree, user
 * title, status, environment, and lifecycle history, while native ref/title
 * data is read through `agent_conversations` (SPEC §3–§5).
 *
 * A pre-existing duplicate placement at the exact same
 * (conversation, project, worktree) is retained as a placement alias so its
 * UUID, logs, events, and saved-layout references remain valid. Only the
 * canonical row owns the conversation link and branch; new duplicates are
 * prevented by the partial unique index.
 */
export const migration021 = {
  version: 21,
  name: 'agent-conversations',
  sql: `
CREATE TABLE agent_conversations (
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  agent_type TEXT NOT NULL,
  agent_session_ref TEXT NOT NULL,
  native_cwd TEXT NOT NULL,
  native_title TEXT,
  parent_conversation_id INTEGER REFERENCES agent_conversations(id) ON DELETE SET NULL,
  preferred_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  native_created_at TEXT,
  native_updated_at TEXT,
  last_seen_at TEXT NOT NULL,
  missing_scan_count INTEGER NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0,
  UNIQUE(profile_id, agent_type, agent_session_ref)
);

INSERT INTO agent_conversations (
  profile_id, agent_type, agent_session_ref, native_cwd, native_title,
  preferred_account_id, native_created_at, native_updated_at, last_seen_at
)
SELECT
  p.profile_id,
  s.agent_type,
  s.agent_session_ref,
  MIN(s.worktree_path),
  MAX(s.agent_title),
  MIN(s.account_id),
  MIN(s.created_at),
  MAX(COALESCE(s.last_activity_at, s.updated_at)),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM sessions s
JOIN projects p ON p.id = s.project_id
WHERE s.kind = 'agent'
  AND s.agent_type IS NOT NULL
  AND s.agent_session_ref IS NOT NULL
GROUP BY p.profile_id, s.agent_type, s.agent_session_ref;

CREATE TEMP TABLE _session_conversation_map AS
SELECT s.id AS session_id, c.id AS conversation_id, s.project_id, s.worktree_path
FROM sessions s
JOIN projects p ON p.id = s.project_id
JOIN agent_conversations c
  ON c.profile_id = p.profile_id
 AND c.agent_type = s.agent_type
 AND c.agent_session_ref = s.agent_session_ref
WHERE s.agent_session_ref IS NOT NULL;

CREATE TEMP TABLE _canonical_placements AS
SELECT DISTINCT
  m.conversation_id,
  m.project_id,
  m.worktree_path,
  (
    SELECT s2.id
    FROM _session_conversation_map m2
    JOIN sessions s2 ON s2.id = m2.session_id
    WHERE m2.conversation_id = m.conversation_id
      AND m2.project_id = m.project_id
      AND m2.worktree_path = m.worktree_path
    ORDER BY
      CASE WHEN s2.status IN ('starting', 'running', 'waiting_input') THEN 0 ELSE 1 END,
      s2.created_at,
      s2.id
    LIMIT 1
  ) AS canonical_id
FROM _session_conversation_map m;

CREATE TEMP TABLE _branch_owners AS
SELECT worktree_path, id AS owner_id
FROM (
  SELECT
    s.id,
    s.worktree_path,
    ROW_NUMBER() OVER (
      PARTITION BY s.worktree_path
      ORDER BY
        CASE WHEN scm.conversation_id IS NULL OR cp.canonical_id = s.id THEN 0 ELSE 1 END,
        s.created_at,
        s.id
    ) AS owner_rank
  FROM sessions s
  LEFT JOIN _session_conversation_map scm ON scm.session_id = s.id
  LEFT JOIN _canonical_placements cp
    ON cp.conversation_id = scm.conversation_id
   AND cp.project_id = s.project_id
   AND cp.worktree_path = s.worktree_path
  WHERE s.separate_branch = 1
)
WHERE owner_rank = 1;

CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  account_id INTEGER REFERENCES accounts(id),
  conversation_id INTEGER REFERENCES agent_conversations(id) ON DELETE SET NULL,
  placement_alias_of TEXT REFERENCES sessions_new(id) ON DELETE SET NULL,
  worktree_path TEXT NOT NULL,
  canonical_worktree_path TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  branch TEXT NOT NULL,
  separate_branch INTEGER NOT NULL DEFAULT 1,
  branch_owned INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'agent',
  agent_type TEXT,
  title TEXT,
  osc_title TEXT,
  status TEXT NOT NULL,
  native_sync TEXT,
  skip_permissions INTEGER NOT NULL DEFAULT 0,
  session_env TEXT NOT NULL DEFAULT '{}',
  cwd TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT
);

INSERT INTO sessions_new (
  id, project_id, account_id, conversation_id, placement_alias_of,
  worktree_path, canonical_worktree_path, base_branch, branch,
  separate_branch, branch_owned, kind, agent_type, title, osc_title,
  status, native_sync, skip_permissions, session_env, cwd,
  created_at, updated_at, last_activity_at
)
SELECT
  s.id,
  s.project_id,
  s.account_id,
  CASE WHEN cp.canonical_id = s.id THEN scm.conversation_id ELSE NULL END,
  CASE WHEN cp.canonical_id IS NOT NULL AND cp.canonical_id != s.id THEN cp.canonical_id ELSE NULL END,
  s.worktree_path,
  s.worktree_path,
  s.base_branch,
  s.branch,
  s.separate_branch,
  CASE WHEN bo.owner_id = s.id THEN 1 ELSE 0 END,
  s.kind,
  s.agent_type,
  s.title,
  s.osc_title,
  s.status,
  CASE WHEN s.kind = 'agent' THEN 'fallback' ELSE NULL END,
  s.skip_permissions,
  s.session_env,
  s.cwd,
  s.created_at,
  s.updated_at,
  s.last_activity_at
FROM sessions s
LEFT JOIN _session_conversation_map scm ON scm.session_id = s.id
LEFT JOIN _canonical_placements cp
  ON cp.conversation_id = scm.conversation_id
 AND cp.project_id = s.project_id
 AND cp.worktree_path = s.worktree_path
LEFT JOIN _branch_owners bo ON bo.worktree_path = s.worktree_path;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX idx_sessions_project ON sessions(project_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_conversation ON sessions(conversation_id);
CREATE UNIQUE INDEX idx_sessions_conversation_placement
ON sessions(conversation_id, project_id, canonical_worktree_path)
WHERE conversation_id IS NOT NULL;
CREATE UNIQUE INDEX idx_sessions_branch_owner
ON sessions(canonical_worktree_path)
WHERE branch_owned = 1;
CREATE INDEX idx_conversations_profile_agent
ON agent_conversations(profile_id, agent_type);
CREATE INDEX idx_conversations_preferred_account
ON agent_conversations(preferred_account_id);

DROP TABLE _branch_owners;
DROP TABLE _canonical_placements;
DROP TABLE _session_conversation_map;
`,
};
