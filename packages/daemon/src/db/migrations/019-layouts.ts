/**
 * Saved layouts (SPEC §11): named snapshots of the centre tiling tree, saved
 * and loaded from the top-bar Layouts popover. Scoping mirrors the scratchpad
 * table: each row is profile- or project-scoped, with the scope/project_id
 * invariant (project ⇒ project_id set; profile ⇒ null) enforced by the store,
 * not a CHECK. `layout_tree` and `active_session` are the captured
 * ProjectLayout-shaped slice; the tree is stored as its JSON wire shape and
 * validated through `layoutNodeSchema` on read.
 */
export const migration019 = {
  version: 19,
  name: 'layouts',
  sql: `
CREATE TABLE layouts (
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  scope TEXT NOT NULL DEFAULT 'profile',        -- 'project' | 'profile'
  project_id TEXT REFERENCES projects(id),      -- set iff scope='project'
  name TEXT NOT NULL,
  layout_tree TEXT,                             -- JSON LayoutNode; NULL = empty workspace
  active_session TEXT,                          -- the bound session at capture time
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_layouts_profile ON layouts(profile_id);
`,
};
