/** Huddle stop intent has no terminal segment and is consumed before dispatch. */
export const migration044 = {
  version: 44,
  name: 'huddle-stop-requests',
  sql: `
CREATE TABLE huddle_stop_requests (
  runtime_id TEXT PRIMARY KEY REFERENCES runtime_bindings(runtime_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  requested_at TEXT NOT NULL
);
`,
};
