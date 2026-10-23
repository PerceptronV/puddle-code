/** Language defaults inherit into every project without rewriting per-file overrides. */
export const migration027 = {
  version: 27,
  name: 'compilation-defaults',
  sql: `
CREATE TABLE compilation_defaults (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('on_demand', 'eager')),
  command TEXT NOT NULL,
  PRIMARY KEY (profile_id, provider, mode)
);
`,
} as const;
