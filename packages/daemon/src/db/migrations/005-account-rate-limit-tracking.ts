/**
 * Per-account opt-in for subscription rate-limit tracking. Off by default:
 * fetching that data means the adapter reads the account's own OAuth token
 * (SPEC §2 carve-out), so it happens only where the user has knowingly
 * enabled it. A plain column add — no table rebuild.
 */
export const migration005 = {
  version: 5,
  name: 'account-rate-limit-tracking',
  sql: `
ALTER TABLE accounts ADD COLUMN rate_limit_tracking INTEGER NOT NULL DEFAULT 0;
`,
};
