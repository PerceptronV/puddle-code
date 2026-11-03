/** Durable ownership is separate from immutable placements and native conversations. */
export const migration029 = {
  version: 29,
  name: 'runtime-bindings',
  sql: `
CREATE TABLE runtime_bindings (
  runtime_id TEXT PRIMARY KEY,
  incarnation TEXT NOT NULL UNIQUE,
  launch_id TEXT NOT NULL UNIQUE,
  launch_fingerprint TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  launch_session_id TEXT NOT NULL REFERENCES sessions(id),
  active_session_id TEXT NOT NULL REFERENCES sessions(id),
  account_id INTEGER REFERENCES accounts(id),
  agent_type TEXT,
  canonical_worktree_path TEXT NOT NULL,
  conversation_id INTEGER REFERENCES agent_conversations(id),
  build TEXT NOT NULL,
  protocol_major INTEGER NOT NULL CHECK (protocol_major >= 0),
  protocol_minor INTEGER NOT NULL CHECK (protocol_minor >= 0),
  release_path TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'running', 'exited', 'failed', 'interrupted')),
  event_cursor INTEGER NOT NULL DEFAULT -1 CHECK (event_cursor >= -1),
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE UNIQUE INDEX idx_runtime_live_placement ON runtime_bindings(active_session_id)
  WHERE state IN ('prepared', 'running');
CREATE UNIQUE INDEX idx_runtime_live_conversation ON runtime_bindings(conversation_id)
  WHERE conversation_id IS NOT NULL AND state IN ('prepared', 'running');
CREATE INDEX idx_runtime_profile ON runtime_bindings(profile_id);
`,
};
