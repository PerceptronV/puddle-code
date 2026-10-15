import type { Migration } from './index.js';

export const migration026: Migration = {
  version: 26,
  name: 'headless-mode',
  // Replace the column's CHECK constraint without rebuilding placements or
  // changing their identities, accounts, conversation links or timestamps.
  sql: `
    ALTER TABLE sessions ADD COLUMN headless_agent_mode TEXT NOT NULL DEFAULT 'interactive'
      CHECK (headless_agent_mode IN ('interactive', 'headless'));
    UPDATE sessions SET headless_agent_mode =
      CASE agent_mode WHEN 'scripted' THEN 'headless' ELSE agent_mode END;
    ALTER TABLE sessions DROP COLUMN agent_mode;
    ALTER TABLE sessions RENAME COLUMN headless_agent_mode TO agent_mode;
  `,
};
