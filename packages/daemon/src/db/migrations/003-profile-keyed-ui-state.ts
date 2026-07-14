/**
 * Workspace layouts move from (project, client) to (project, profile) keying:
 * layout follows identity, not browser — any machine or tunnel port restores
 * the same workspace once the profile is picked (decision 2026-07-13).
 * Existing rows cannot map a client uuid to a profile, so each project keeps
 * its most recent snapshot, keyed to the project's owning profile.
 * Runs with foreign_keys OFF (see db.ts migrate()).
 */
export const migration003 = {
  version: 3,
  name: 'profile-keyed-ui-state',
  sql: `
CREATE TABLE project_states_new (
  project_id TEXT NOT NULL REFERENCES projects(id),
  profile_id INTEGER NOT NULL REFERENCES profiles(id),
  ui_state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, profile_id)
);
INSERT INTO project_states_new
  SELECT ps.project_id, p.profile_id, ps.ui_state, MAX(ps.updated_at)
  FROM project_states ps JOIN projects p ON p.id = ps.project_id
  GROUP BY ps.project_id;

DROP TABLE project_states;
ALTER TABLE project_states_new RENAME TO project_states;
`,
};
