/** One consumed host lifecycle attempt; replacement identity binds inside runtime preparation. */
export const migration050 = {
  version: 50,
  name: 'huddle-session-operations',
  sql: `
CREATE TABLE huddle_session_operations (
  owner_runtime_id TEXT NOT NULL REFERENCES runtime_bindings(runtime_id),
  operation_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  previous_runtime_id TEXT REFERENCES runtime_bindings(runtime_id),
  review TEXT,
  runtime_id TEXT UNIQUE REFERENCES runtime_bindings(runtime_id),
  outcome TEXT,
  PRIMARY KEY (owner_runtime_id, operation_id)
);
`,
};
