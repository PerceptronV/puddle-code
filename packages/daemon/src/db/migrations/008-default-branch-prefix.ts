/**
 * `puddle/` is now the default branch prefix (SPEC §11). Profiles that never
 * set one carry an empty prefix (older default), so their session branches
 * came out unprefixed; adopt the new default for them. Profiles with a custom
 * prefix are left alone, and a user may still clear it back to empty in
 * settings afterwards — this only changes the default, not an explicit choice.
 */
export const migration008 = {
  version: 8,
  name: 'default-branch-prefix',
  sql: `
UPDATE profiles SET branch_prefix = 'puddle/' WHERE branch_prefix = '';
`,
};
