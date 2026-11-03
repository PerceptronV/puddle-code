/** Exact terminal generations for immutable placement history and viewer fencing. */
export const migration032 = {
  version: 32,
  name: 'runtime-segment-terminals',
  sql: `
CREATE TABLE terminal_placements (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  runtime_id TEXT REFERENCES runtime_bindings(runtime_id) ON DELETE SET NULL
);
INSERT OR REPLACE INTO terminal_placements (session_id, runtime_id)
SELECT s.session_id, s.runtime_id FROM runtime_segments s JOIN runtime_bindings r USING (runtime_id)
ORDER BY r.created_at, r.rowid, s.start_cursor;
CREATE TABLE runtime_segment_terminals (
  segment_id TEXT NOT NULL REFERENCES runtime_segments(segment_id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  generation TEXT NOT NULL,
  PRIMARY KEY (segment_id, term)
);
-- Only a currently live terminal proves membership of the current segment.
-- Older experimental historical mappings cannot be invented from current state.
INSERT INTO runtime_segment_terminals (segment_id, term, generation)
SELECT r.active_segment_id, json_extract(t.value, '$.term'), json_extract(t.value, '$.generation')
FROM runtime_bindings r JOIN runtime_observations o USING (runtime_id), json_each(o.terminals) t
WHERE r.state IN ('prepared', 'running') AND r.active_segment_id IS NOT NULL
  AND json_extract(t.value, '$.pid') IS NOT NULL;
`,
};
