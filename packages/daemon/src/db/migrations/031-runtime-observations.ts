/** Private reconciliation state; provider replies never enter public session events. */
export const migration031 = {
  version: 31,
  name: 'runtime-observations',
  sql: `
CREATE TABLE runtime_observations (
  runtime_id TEXT PRIMARY KEY REFERENCES runtime_bindings(runtime_id) ON DELETE CASCADE,
  capture_enabled INTEGER NOT NULL CHECK (capture_enabled IN (0, 1)),
  terminals TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE runtime_turns (
  runtime_id TEXT NOT NULL REFERENCES runtime_bindings(runtime_id) ON DELETE CASCADE,
  turn INTEGER NOT NULL CHECK (turn > 0),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  segment_id TEXT NOT NULL REFERENCES runtime_segments(segment_id),
  result TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  PRIMARY KEY (runtime_id, turn)
);
`,
};
