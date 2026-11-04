/** Programme ownership names the exact launch, never a later runtime in its placement. */
export const migration036 = {
  version: 36,
  name: 'puddlang-runtime-spawns',
  sql: `
CREATE TABLE puddlang_runtime_spawns (
  run_id TEXT NOT NULL REFERENCES puddlang_runs(id) ON DELETE CASCADE,
  operation_id INTEGER NOT NULL,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
  runtime_id TEXT UNIQUE REFERENCES runtime_bindings(runtime_id),
  stop_requested INTEGER NOT NULL DEFAULT 0 CHECK (stop_requested IN (0, 1)),
  PRIMARY KEY (run_id, operation_id)
);
CREATE TABLE puddlang_stop_requests (
  run_id TEXT PRIMARY KEY REFERENCES puddlang_runs(id) ON DELETE CASCADE
);
`,
};
