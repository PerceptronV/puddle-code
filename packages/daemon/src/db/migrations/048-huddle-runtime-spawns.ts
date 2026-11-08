/** Keep huddle spawn consumption separate from daemon-owned puddlang programmes. */
export const migration048 = {
  version: 48,
  name: 'huddle-runtime-spawns',
  sql: `
CREATE TABLE huddle_runtime_spawns (
  owner_runtime_id TEXT NOT NULL REFERENCES runtime_bindings(runtime_id),
  operation_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
  runtime_id TEXT UNIQUE REFERENCES runtime_bindings(runtime_id),
  stop_requested INTEGER NOT NULL DEFAULT 0 CHECK (stop_requested IN (0, 1)),
  PRIMARY KEY (owner_runtime_id, operation_id)
);
CREATE INDEX huddle_runtime_spawns_execution ON huddle_runtime_spawns(owner_runtime_id, execution_id);
`,
};
