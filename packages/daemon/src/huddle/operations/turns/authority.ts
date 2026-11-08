import type { Db } from '../../../db/db.js';
import { ApiError } from '../../../http/errors.js';
import type { HuddleTurnScope } from '@puddle/shared';
import { requireHuddleOwnerScope } from '../authority.js';

/** Observation includes exact admitted-turn cancellation, never a fresh prompt. */
export type HuddleTurnAuthority = (mode: 'dispatch' | 'observe') => boolean;

export function requireHuddleTurnAuthority(
  authorised: HuddleTurnAuthority,
  mode: 'dispatch' | 'observe',
) {
  if (!authorised(mode))
    throw new ApiError(403, 'huddle_scope', 'Huddle operation authority expired');
}

/** Durable scope is necessary but never substitutes for current private bridge authority. */
export function requireHuddleTurnScope(
  db: Db,
  scope: HuddleTurnScope,
  authorised: HuddleTurnAuthority,
  mode: 'dispatch' | 'observe',
) {
  requireHuddleTurnAuthority(authorised, mode);
  const { owner, target } = scope;
  const dispatch = mode === 'dispatch';
  const huddleId = requireHuddleOwnerScope(db, owner, dispatch);
  const destination = db
    .prepare(
      `SELECT b.state, b.active_session_id, s.status, p.archived,
  EXISTS (SELECT 1 FROM runtime_stop_requests WHERE runtime_id = b.runtime_id) AS stopping
  FROM runtime_bindings b JOIN sessions s ON s.id = ? JOIN projects p ON p.id = s.project_id
  WHERE b.runtime_id = ? AND b.incarnation = ? AND b.role = 'session' AND s.kind = 'agent'
  AND b.profile_id = ? AND p.profile_id = b.profile_id AND s.project_id = ?
  AND b.canonical_worktree_path = ? AND s.canonical_worktree_path = b.canonical_worktree_path`,
    )
    .get(
      target.sessionId,
      target.runtimeId,
      target.incarnation,
      owner.profile_id,
      target.projectId,
      target.worktree,
    ) as
    | {
        state: string;
        active_session_id: string;
        status: string;
        archived: number;
        stopping: number;
      }
    | undefined;
  if (
    !destination ||
    (dispatch &&
      (destination.state !== 'running' ||
        destination.active_session_id !== target.sessionId ||
        destination.status === 'archived' ||
        destination.archived ||
        destination.stopping))
  )
    throw new ApiError(403, 'huddle_scope', 'Huddle or agent binding is no longer available');
  return huddleId;
}
