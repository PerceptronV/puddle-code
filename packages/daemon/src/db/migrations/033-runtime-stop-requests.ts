/** Explicit stop intent survives controller loss and suppresses automatic resume. */
export const migration033 = {
  version: 33,
  name: 'runtime-stop-requests',
  sql: `
CREATE TABLE runtime_stop_requests (
  runtime_id TEXT PRIMARY KEY REFERENCES runtime_bindings(runtime_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  segment_id TEXT NOT NULL REFERENCES runtime_segments(segment_id),
  requested_at TEXT NOT NULL
);
`,
};
