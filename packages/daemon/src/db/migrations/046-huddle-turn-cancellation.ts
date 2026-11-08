export const migration046 = {
  version: 46,
  name: 'huddle-turn-cancellation',
  sql: `ALTER TABLE huddle_runtime_turns ADD COLUMN cancellation_attempted INTEGER NOT NULL DEFAULT 0 CHECK (cancellation_attempted IN (0, 1));`,
};
