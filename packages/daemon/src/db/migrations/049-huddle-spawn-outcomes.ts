export const migration049 = {
  version: 49,
  name: 'huddle-spawn-outcomes',
  sql: `
ALTER TABLE huddle_runtime_spawns ADD COLUMN outcome TEXT
  CHECK (outcome IS NULL OR length(CAST(outcome AS BLOB)) <= 32768);
ALTER TABLE huddle_runtime_spawns ADD COLUMN stop_attempted INTEGER NOT NULL DEFAULT 0
  CHECK (stop_attempted IN (0, 1));
`,
};
