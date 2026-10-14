import type { Migration } from './index.js';

export const migration025: Migration = {
  version: 25,
  name: 'agent-mode',
  sql: `ALTER TABLE sessions ADD COLUMN agent_mode TEXT NOT NULL DEFAULT 'interactive'
    CHECK (agent_mode IN ('interactive', 'scripted'));`,
};
