/**
 * Subscription usage is now fetched credential-free via the agent's own CLI
 * (`claude -p /usage`), so the per-account opt-in that justified reading the
 * OAuth token is gone — bars simply appear for logged-in accounts.
 */
export const migration007 = {
  version: 7,
  name: 'drop-rate-limit-tracking',
  sql: `
ALTER TABLE accounts DROP COLUMN rate_limit_tracking;
`,
};
