/**
 * The Scratchpad (SPEC §11): a per-profile bank of reusable prompts and notes,
 * each either project-scoped (shown only in that project) or profile-scoped
 * (shown in every project). Replaces the dormant `prompts` table from migration
 * 001 — never wired to a store/route/UI, so nothing has ever written to it —
 * with a `scratchpad` table that adds the hard `scope`, a manual `position`
 * order (smaller = higher, so a fresh entry sorts to the top), and drops the
 * old frecency columns (`use_count`/`last_used_at`) since ordering is now manual.
 * The scope/project_id invariant (project ⇒ project_id set; profile ⇒ null) is
 * enforced by the store, not a CHECK.
 */
export const migration014 = {
  version: 14,
  name: 'scratchpad',
  sql: `
DROP TABLE prompts;

CREATE TABLE scratchpad (
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  scope TEXT NOT NULL DEFAULT 'project',        -- 'project' | 'profile'
  project_id TEXT REFERENCES projects(id),      -- set iff scope='project'
  title TEXT,                                   -- optional label; body's first line shown if absent
  body TEXT NOT NULL,                           -- plaintext prompt/note, inserted verbatim
  tags TEXT NOT NULL DEFAULT '[]',              -- JSON array of free-form strings
  agent_type TEXT,                              -- optional adapter-id association
  position REAL NOT NULL,                       -- manual order; SMALLER = higher (top)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_scratchpad_profile ON scratchpad(profile_id);
`,
};
