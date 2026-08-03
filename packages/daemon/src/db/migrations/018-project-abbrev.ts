/**
 * Projects gain a user-chosen abbreviation (protocol 12.1, SPEC §12): the ≤5
 * character uppercase label the collapsed sidebar rail shows. Nullable — rows
 * from before this migration stay null and the UI derives the label from the
 * project name, exactly as it always did.
 */
export const migration018 = {
  version: 18,
  name: 'project-abbrev',
  sql: `
ALTER TABLE projects ADD COLUMN abbrev TEXT;
`,
};
