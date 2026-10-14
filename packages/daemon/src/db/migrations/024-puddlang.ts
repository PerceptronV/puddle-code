import type { Migration } from './index.js';

export const migration024: Migration = {
  version: 24,
  name: 'puddlang',
  sql: `
    CREATE TABLE puddlang_runs (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      source_hash TEXT NOT NULL,
      submission TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE puddlang_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES puddlang_runs(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX puddlang_events_run ON puddlang_events(run_id, sequence);
  `,
};
