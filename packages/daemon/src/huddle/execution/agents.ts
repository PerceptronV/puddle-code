import { realpathSync } from 'node:fs';
import { encodeHuddleAgentTarget } from '@puddle/shared';
import type { SessionStore } from '../../db/stores/sessions.js';
import type { RuntimeStore } from '../../db/stores/runtimes.js';
import type { RuntimeProgrammeTurns } from '../../runtime/controller/programme-turns.js';
import { ApiError } from '../../http/errors.js';

export function resolveHuddleAgent(
  deps: { sessions: SessionStore; runtimes: RuntimeStore; turns: RuntimeProgrammeTurns },
  profile: string,
  project: string,
  reference: string,
  worktree: string,
) {
  const session = deps.sessions.get(reference);
  const owner = deps.runtimes.ownerOf(reference);
  if (
    session.kind !== 'agent' ||
    session.status === 'archived' ||
    session.project_id !== project ||
    !owner ||
    owner.role !== 'session' ||
    owner.profile_id !== profile ||
    owner.active_session_id !== reference ||
    owner.canonical_worktree_path !== worktree ||
    realpathSync(session.worktree_path) !== worktree ||
    deps.runtimes.stopRequested(owner.runtime_id)
  )
    throw ApiError.conflict(
      'huddle_agent_unavailable',
      'Choose a live agent in this project and the declared worktree',
    );
  const current = deps.turns.inspect(reference);
  if (
    !current ||
    current.handle.runtime_id !== owner.runtime_id ||
    current.handle.session_id !== reference
  )
    throw ApiError.conflict('huddle_agent_unavailable', 'Agent runtime changed during binding');
  return encodeHuddleAgentTarget({
    runtimeId: owner.runtime_id,
    incarnation: owner.incarnation,
    sessionId: reference,
    projectId: project,
    worktree,
  });
}
