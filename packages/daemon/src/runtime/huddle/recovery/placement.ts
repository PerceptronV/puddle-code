import type { RuntimeBinding, RuntimeStore } from '../../../db/stores/runtimes.js';
import type { SessionStore } from '../../../db/stores/sessions.js';
import type { ProjectStore } from '../../../db/stores/projects.js';
import { requireHuddleSource } from '../../../huddle/execution/source.js';

/** Shared automatic-recovery placement checks, repeated after asynchronous admission. */
export function huddleRecoveryPlacementAvailable(
  deps: {
    runtimes: Pick<RuntimeStore, 'stopRequested'>;
    sessions: Pick<SessionStore, 'get'>;
    projects: Pick<ProjectStore, 'get'>;
  },
  binding: RuntimeBinding,
): boolean {
  try {
    const session = deps.sessions.get(binding.active_session_id);
    const project = deps.projects.get(session.project_id);
    if (
      session.kind !== 'huddle' ||
      session.huddle_id !== binding.huddle_id ||
      session.status === 'archived' ||
      project.archived ||
      session.project_id !== binding.project_id ||
      project.profile_id !== binding.profile_id ||
      session.worktree_path !== binding.canonical_worktree_path ||
      deps.runtimes.stopRequested(binding.runtime_id)
    )
      return false;
    requireHuddleSource(session);
    return true;
  } catch {
    return false;
  }
}
