import { existsSync } from 'node:fs';
import type { EventStore } from '../db/stores/events.js';
import type { ProjectStore } from '../db/stores/projects.js';
import type { SessionStore } from '../db/stores/sessions.js';
import type { RuntimeStore } from '../db/stores/runtimes.js';
import type { MarkerFileSync } from './onboarding.js';

export interface ReconcileResult {
  interrupted: string[];
  /** External ownership must be reconciled before these placements can resume. */
  protected: string[];
}

/**
 * Boot reconcile pass (SPEC §4): any session that claims to be live but has
 * no durable external owner becomes `interrupted`. An external binding remains
 * protected until authenticated adoption or confirmed-loss reconciliation ends
 * it; an absent in-process PTY is not evidence of external process death.
 * Orphan worktrees are computed on demand by the repos route; worktree-missing
 * badges are computed on session reads. Nothing is ever auto-deleted.
 */
export function reconcilePass(deps: {
  sessions: SessionStore;
  events: EventStore;
  projects: ProjectStore;
  onboarding: MarkerFileSync;
  runtimes?: RuntimeStore;
}): ReconcileResult {
  const protectedIds = new Set(
    (deps.runtimes?.live() ?? []).map((binding) => binding.active_session_id),
  );
  const stuck = deps.sessions.listByStatus(['starting', 'running', 'waiting_input']);
  const interrupted = stuck.filter((s) => !protectedIds.has(s.id));
  const unstarted = deps.runtimes?.unstartedProgrammeSessions() ?? new Set<string>();
  const huddleUnstarted = deps.runtimes?.unstartedHuddleSessions() ?? new Set<string>();
  for (const s of interrupted) {
    deps.sessions.setStatus(s.id, 'interrupted');
    deps.events.record(s.id, 'interrupted', {
      reason: unstarted.has(s.id)
        ? 'programme_spawn_not_dispatched'
        : huddleUnstarted.has(s.id)
          ? 'huddle_spawn_not_dispatched'
          : 'daemon_restart',
    });
  }
  // Re-register notes watchers for every session that can still teach rules.
  for (const s of deps.sessions.listByStatus(['exited', 'interrupted'])) {
    if (s.kind !== 'huddle' && existsSync(s.worktree_path)) {
      deps.onboarding.watch(s.id, deps.projects.get(s.project_id).repo_id, s.worktree_path);
    }
  }
  return {
    interrupted: interrupted
      .filter((s) => s.kind !== 'huddle' && !unstarted.has(s.id) && !huddleUnstarted.has(s.id))
      .map((s) => s.id),
    protected: [...protectedIds],
  };
}
