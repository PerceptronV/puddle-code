/** Huddles are real placements and owners, without terminal segments or native conversations. */
export const migration043 = {
  version: 43,
  name: 'huddle-placements',
  sql: `
ALTER TABLE sessions ADD COLUMN huddle_id TEXT;
CREATE UNIQUE INDEX idx_huddle_definition_placement
  ON sessions(project_id, canonical_worktree_path, huddle_id) WHERE kind = 'huddle';
CREATE TRIGGER huddle_session_insert BEFORE INSERT ON sessions
WHEN (NEW.kind = 'huddle' AND (
  NEW.huddle_id IS NULL OR length(NEW.huddle_id) != 32 OR NEW.huddle_id GLOB '*[^0-9a-f]*'
  OR NEW.account_id IS NOT NULL OR NEW.agent_type IS NOT NULL OR NEW.conversation_id IS NOT NULL
  OR NEW.placement_alias_of IS NOT NULL OR NEW.separate_branch != 0 OR NEW.branch_owned != 0
  OR NEW.skip_permissions != 0 OR NEW.cwd IS NOT NULL
)) OR (NEW.kind != 'huddle' AND NEW.huddle_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Invalid huddle session identity'); END;
CREATE TRIGGER huddle_session_update BEFORE UPDATE ON sessions
WHEN ((OLD.kind = 'huddle' OR NEW.kind = 'huddle') AND (
  NEW.kind != OLD.kind OR NEW.huddle_id IS NOT OLD.huddle_id
  OR NEW.project_id != OLD.project_id OR NEW.canonical_worktree_path != OLD.canonical_worktree_path
  OR NEW.worktree_path != OLD.worktree_path OR NEW.account_id IS NOT NULL
  OR NEW.agent_type IS NOT NULL OR NEW.conversation_id IS NOT NULL
  OR NEW.placement_alias_of IS NOT NULL OR NEW.separate_branch != 0 OR NEW.branch_owned != 0
  OR NEW.skip_permissions != 0 OR NEW.cwd IS NOT NULL
)) OR (NEW.kind != 'huddle' AND NEW.huddle_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Huddle placement identity is immutable'); END;
ALTER TABLE runtime_bindings ADD COLUMN role TEXT NOT NULL DEFAULT 'session' CHECK (role IN ('session', 'huddle'));
ALTER TABLE runtime_bindings ADD COLUMN huddle_id TEXT;
ALTER TABLE runtime_bindings ADD COLUMN huddle_capabilities TEXT;
`,
};
