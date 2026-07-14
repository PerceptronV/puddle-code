/**
 * Sessions may opt out of branch isolation (SPEC §4): `separate_branch = 0`
 * means the session works directly on its base branch in a worktree shared
 * with every other such session on that branch. Existing rows are all
 * branch-isolated, hence DEFAULT 1. A plain column add — no table rebuild.
 */
export const migration006 = {
  version: 6,
  name: 'session-separate-branch',
  sql: `
ALTER TABLE sessions ADD COLUMN separate_branch INTEGER NOT NULL DEFAULT 1;
`,
};
