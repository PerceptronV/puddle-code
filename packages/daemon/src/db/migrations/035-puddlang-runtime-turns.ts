/** Private operation identities survive daemon loss without making prompts replayable. */
export const migration035 = {
  version: 35,
  name: 'puddlang-runtime-turns',
  sql: `
CREATE TABLE puddlang_runtime_turns (
  run_id TEXT NOT NULL REFERENCES puddlang_runs(id) ON DELETE CASCADE,
  operation_id INTEGER NOT NULL,
  runtime_id TEXT NOT NULL REFERENCES runtime_bindings(runtime_id),
  turn INTEGER NOT NULL CHECK (turn > 0),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  segment_id TEXT NOT NULL REFERENCES runtime_segments(segment_id),
  expected_ref TEXT,
  PRIMARY KEY (run_id, operation_id),
  UNIQUE (runtime_id, turn)
);
`,
};
