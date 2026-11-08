import type { RuntimeIdentity } from '@puddle/shared';
import type { Db } from '../../db/db.js';
import { ApiError } from '../../http/errors.js';

/** Durable owner identity supplements, but never replaces, private caller authority. */
export function requireHuddleOwnerScope(db: Db, owner: RuntimeIdentity, dispatch: boolean) {
  const source = db
    .prepare(
      `SELECT b.state, b.huddle_id, s.status, p.archived,
  EXISTS (SELECT 1 FROM huddle_stop_requests WHERE runtime_id = b.runtime_id) AS stopping
  FROM runtime_bindings b JOIN sessions s ON s.id = b.launch_session_id
  JOIN projects p ON p.id = s.project_id
  WHERE b.runtime_id = ? AND b.incarnation = ? AND b.launch_id = ? AND b.role = 'huddle'
  AND b.profile_id = ? AND p.profile_id = b.profile_id AND b.project_id = ? AND s.project_id = b.project_id
  AND s.id = ? AND s.kind = 'huddle' AND s.huddle_id = b.huddle_id
  AND s.canonical_worktree_path = ? AND b.canonical_worktree_path = s.canonical_worktree_path`,
    )
    .get(
      owner.runtime_id,
      owner.incarnation,
      owner.launch_id,
      owner.profile_id,
      owner.project_id,
      owner.session_id,
      owner.canonical_worktree_path,
    ) as
    | { state: string; huddle_id: string; status: string; archived: number; stopping: number }
    | undefined;
  if (
    !source ||
    (dispatch &&
      (source.state !== 'running' ||
        source.status === 'archived' ||
        source.archived ||
        source.stopping))
  )
    throw new ApiError(403, 'huddle_scope', 'Huddle binding is no longer available');
  return source.huddle_id;
}
