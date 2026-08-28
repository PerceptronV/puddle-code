/** Durable per-file command overrides for modular compilation providers. */
export const migration022 = {
  version: 22,
  name: 'compilation-settings',
  sql: `
CREATE TABLE compilation_settings (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('on_demand', 'eager')),
  command TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, project_id, provider, file_type, file_path, mode)
);
`,
} as const;
