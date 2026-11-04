/** Read outcomes may be reclaimed without reusing their admitted identities. */
export const migration037 = {
  version: 37,
  name: 'runtime-turn-retention',
  sql: `
ALTER TABLE runtime_turns ADD COLUMN consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1));
CREATE TABLE runtime_turn_watermarks (
  runtime_id TEXT PRIMARY KEY REFERENCES runtime_bindings(runtime_id) ON DELETE CASCADE,
  turn INTEGER NOT NULL CHECK (turn > 0)
);
INSERT INTO runtime_turn_watermarks (runtime_id, turn)
SELECT runtime_id, MAX(turn) FROM runtime_turns GROUP BY runtime_id;
`,
};
