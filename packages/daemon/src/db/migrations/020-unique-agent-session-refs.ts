/**
 * One agent-native conversation may back only one puddle session within an
 * account. Older Codex/OpenCode discovery could assign the same newest cwd
 * conversation to several rows; clear every ambiguous duplicate so the
 * adapter can recover each one from its creation time on the next resume.
 */
export const migration020 = {
  version: 20,
  name: 'unique-agent-session-refs',
  sql: `
UPDATE sessions
SET agent_session_ref = NULL
WHERE account_id IS NOT NULL
  AND agent_session_ref IS NOT NULL
  AND (account_id, agent_session_ref) IN (
    SELECT account_id, agent_session_ref
    FROM sessions
    WHERE account_id IS NOT NULL AND agent_session_ref IS NOT NULL
    GROUP BY account_id, agent_session_ref
    HAVING COUNT(*) > 1
  );

CREATE UNIQUE INDEX idx_sessions_account_agent_ref
ON sessions(account_id, agent_session_ref)
WHERE account_id IS NOT NULL AND agent_session_ref IS NOT NULL;
`,
};
