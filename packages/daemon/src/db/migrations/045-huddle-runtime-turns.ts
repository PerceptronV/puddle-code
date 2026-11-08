/** Huddle callers have their own identities; they are never synthetic puddlang runs. */
export const migration045 = {
  version: 45,
  name: 'huddle-runtime-turns',
  sql: `
CREATE TABLE huddle_runtime_turns (
  owner_runtime_id TEXT NOT NULL REFERENCES runtime_bindings(runtime_id),
  operation_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  runtime_id TEXT NOT NULL REFERENCES runtime_bindings(runtime_id),
  turn INTEGER NOT NULL CHECK (turn > 0),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  segment_id TEXT NOT NULL REFERENCES runtime_segments(segment_id),
  expected_ref TEXT,
  receipt TEXT,
  PRIMARY KEY (owner_runtime_id, operation_id),
  UNIQUE (runtime_id, turn)
);
CREATE INDEX huddle_runtime_turns_execution ON huddle_runtime_turns(owner_runtime_id, execution_id);
`,
};
