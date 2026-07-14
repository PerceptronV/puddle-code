import { existsSync } from 'node:fs';
import type { EventStore } from '../db/stores/events.js';
import type { ProjectStore } from '../db/stores/projects.js';
import type { SessionStore } from '../db/stores/sessions.js';
import type { MarkerFileSync } from './onboarding.js';

export interface ReconcileResult {
  interrupted: string[];
}

/**
 * Boot reconcile pass (SPEC §4): any session that claims to be live but has
 * no PTY (the daemon just started — nothing has) becomes `interrupted`.
 * Orphan worktrees are computed on demand by the repos route; worktree-missing
 * badges are computed on session reads. Nothing is ever auto-deleted.
 */
export function reconcilePass(deps: {
  sessions: SessionStore;
  events: EventStore;
  projects: ProjectStore;
  onboarding: MarkerFileSync;
}): ReconcileResult {
  const stuck = deps.sessions.listByStatus(['starting', 'running', 'waiting_input']);
  for (const s of stuck) {
    deps.sessions.setStatus(s.id, 'interrupted');
    deps.events.record(s.id, 'interrupted', { reason: 'daemon_restart' });
  }
  // Re-register notes watchers for every session that can still teach rules.
  for (const s of deps.sessions.listByStatus(['exited', 'interrupted'])) {
    if (existsSync(s.worktree_path)) {
      deps.onboarding.watch(s.id, deps.projects.get(s.project_id).repo_id, s.worktree_path);
    }
  }
  return { interrupted: stuck.map((s) => s.id) };
}
