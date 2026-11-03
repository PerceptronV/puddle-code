/** Immutable output segments acquire a placement only through the daemon's transaction. */
export const migration030 = {
  version: 30,
  name: 'runtime-segments',
  sql: `
ALTER TABLE runtime_bindings ADD COLUMN active_segment_id TEXT;
CREATE TABLE runtime_segments (
  runtime_id TEXT NOT NULL REFERENCES runtime_bindings(runtime_id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  start_cursor INTEGER NOT NULL CHECK (start_cursor >= 0),
  end_cursor INTEGER CHECK (end_cursor >= start_cursor),
  PRIMARY KEY (runtime_id, segment_id)
);
CREATE UNIQUE INDEX idx_runtime_open_segment ON runtime_segments(runtime_id)
  WHERE end_cursor IS NULL;
CREATE INDEX idx_runtime_segment_placement ON runtime_segments(session_id);
`,
};
