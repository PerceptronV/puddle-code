/**
 * `sessions.title` becomes a user-only display override; the agent's own session
 * name (for Claude Code, the transcript's ai-title / agent-name) lives in the new
 * `agent_title` column, maintained by the daemon. The display name is
 * `title ?? agent_title ?? id-prefix` (SPEC §4). Nullable, defaults to NULL for
 * existing rows — a live agent repopulates it on its next status change.
 */
export const migration010 = {
  version: 10,
  name: 'agent-title',
  sql: `
ALTER TABLE sessions ADD COLUMN agent_title TEXT;
`,
};
