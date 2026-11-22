/** Existing history stays registered; only new blank launches can be temporary. */
export const migration052 = {
  version: 52,
  name: 'session-history',
  sql: `
ALTER TABLE sessions ADD COLUMN history_pending INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_sessions_pending_history ON sessions(id) WHERE history_pending = 1;
ALTER TABLE agent_conversations ADD COLUMN history_registered INTEGER NOT NULL DEFAULT 0;
UPDATE agent_conversations SET history_registered = 1;
`,
};
