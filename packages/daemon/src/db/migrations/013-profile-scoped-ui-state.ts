/**
 * Workspace ui_state moves from (project, profile) to profile keying (decision
 * 2026-07-17): the centre editor area is one surface shared across a profile's
 * projects — cross-project tabs live in a single layout tree — so the snapshot
 * follows the profile alone, not the project it happened to be opened from.
 * Each profile seeds from its most recently updated project row — a correlated
 * subquery with an explicit rowid tiebreak, so ties on updated_at (two rows
 * written in the same debounce window) resolve deterministically. The other
 * project rows are necessarily discarded: one workspace per profile now, and
 * a layout tree cannot be merged. Runs with foreign_keys OFF (see db.ts
 * migrate()).
 */
export const migration013 = {
  version: 13,
  name: 'profile-scoped-ui-state',
  sql: `
CREATE TABLE profile_states (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id),
  ui_state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO profile_states
  SELECT o.profile_id,
         (SELECT i.ui_state FROM project_states i
           WHERE i.profile_id = o.profile_id
           ORDER BY i.updated_at DESC, i.rowid DESC LIMIT 1),
         MAX(o.updated_at)
  FROM project_states o
  GROUP BY o.profile_id;

DROP TABLE project_states;
`,
};
