/**
 * Projects can be archived — hidden from the homescreen while every session,
 * worktree, and bit of data is retained; un-archiving restores it all (SPEC §11).
 * A pure hide flag, distinct from archiving a project's sessions. Existing
 * projects default to not-archived.
 */
export const migration011 = {
  version: 11,
  name: 'project-archived',
  sql: `
ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
`,
};
