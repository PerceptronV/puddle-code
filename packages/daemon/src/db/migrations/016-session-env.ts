/**
 * Captured session environment (SPEC §4): exported vars reported by the
 * session's shells over the OSC 7733 side-channel, persisted as a JSON object
 * (name → value) and re-injected into every future PTY spawn for the session.
 * Values may be secrets — the column is stripped in `toSession` and must never
 * ride the sessions API. Plain additive column, so no table rebuild.
 */
export const migration016 = {
  version: 16,
  name: 'session-env',
  sql: `
ALTER TABLE sessions ADD COLUMN session_env TEXT NOT NULL DEFAULT '{}';
`,
};
