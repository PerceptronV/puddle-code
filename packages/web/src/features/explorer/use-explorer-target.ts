import { UNTITLED_SESSION, type Session } from '@puddle/shared';
import type { UiStateHandle } from '../workspace/use-ui-state';

export interface ExplorerTarget {
  /**
   * The worktree the whole left sidebar is bound to. Under the project-directory
   * fallback this is a STAND-IN (see `projectDirectorySession`) rather than a
   * real session, so every navigator can keep asking for `target.session.id` and
   * `target.session.worktree_path`; `root` is what makes those requests land.
   */
  session: Session | null;
  /**
   * The `?root=` every request for this target must carry, or undefined when the
   * session id alone names the directory (a real worktree).
   */
  root: string | undefined;
  /** True when the binding is the project's own directory, not a session's worktree. */
  isProjectDirectory: boolean;
  /** Whether `session` is locked via `explorer_pin`, as opposed to following the active tab. */
  pinned: boolean;
  pin(sid: string): void;
  unpin(): void;
}

/** The one absolute location named by every worktree-scoped navigator header. */
export function explorerLocationPath(
  target: Pick<ExplorerTarget, 'session' | 'root'>,
  browseRoot?: string | null,
): string | null {
  return browseRoot ?? target.root ?? target.session?.worktree_path ?? null;
}

/**
 * Decorate a target so releasing its pin also leaves an ephemeral directory
 * browse. Both the pin button and "Back to the worktree" use this path: a
 * browse creates the pin, so either exit must release both pieces of state.
 */
export function withBrowseReset(target: ExplorerTarget, resetBrowse: () => void): ExplorerTarget {
  return {
    ...target,
    unpin() {
      resetBrowse();
      target.unpin();
    },
  };
}

/** A project's own repository directory, as a binding for the sidebar. */
export interface ProjectDirectory {
  /** Absolute path of the project's repository. */
  path: string;
  projectId: string;
  /** The project's name — the header's label in place of a session title. */
  name: string;
  defaultBranch: string;
}

/**
 * The stand-in "session" for a project-directory binding. The nil uuid is the
 * protocol's "no session applies" id (untitled drafts, 10.3) and the daemon
 * reads it as a DIRECTORY target (12.4), resolving the directory from the
 * `?root=` the sidebar sends alongside — so `/api/worktrees/<nil>/tree?root=…`
 * answers for the project's repository. Nothing here is persisted or attached
 * to: it exists so Files, Changes, Search, and History can bind to a directory
 * through the very props they already take for a worktree.
 */
export function projectDirectorySession(dir: ProjectDirectory): Session {
  return {
    id: UNTITLED_SESSION,
    project_id: dir.projectId,
    account_id: null,
    worktree_path: dir.path,
    base_branch: dir.defaultBranch,
    branch: dir.defaultBranch,
    separate_branch: false,
    kind: 'terminal',
    agent_type: null,
    agent_session_ref: null,
    title: dir.name,
    status: 'exited',
    skip_permissions: false,
    created_at: '1970-01-01T00:00:00.000Z',
    updated_at: '1970-01-01T00:00:00.000Z',
    last_activity_at: null,
  };
}

/**
 * Resolves the worktree the whole left sidebar is bound to (SPEC §8): the
 * session named by `explorer_pin` in the ui-state snapshot, if it still exists
 * and isn't archived; otherwise `boundSessionId` — the caller passes the
 * focused pane's active tab's session (every tab carries the worktree it was
 * opened from), falling back to the URL-bound session. The pin applies across
 * every navigator — Files, Changes, and Search all follow this one binding.
 * `pin`/`unpin` only write the ui-state key; the binding re-derives from the
 * snapshot on every render, so unpinning immediately resumes
 * follow-the-focused-tab with no extra state to reconcile.
 *
 * When nothing qualifies — a project whose sessions are all archived, one with
 * none yet, or simply none in focus — the binding falls back to
 * `projectDirectory`, the project's own repository (decision 2026-08-03): the
 * navigators are never empty while a project is open, which is always. The
 * fallback needs a daemon that understands directory targets, so the caller
 * passes null on an older one and the previous empty state stands.
 */
export function useExplorerTarget(
  sessions: Session[],
  boundSessionId: string | null,
  uiState: UiStateHandle,
  projectDirectory: ProjectDirectory | null = null,
): ExplorerTarget {
  const pinnedId = uiState.snapshot.explorer_pin;
  const pinnedSession =
    pinnedId !== null
      ? (sessions.find((s) => s.id === pinnedId && s.status !== 'archived') ?? null)
      : null;

  const bound = pinnedSession ?? sessions.find((s) => s.id === boundSessionId) ?? null;
  const fallback = bound === null && projectDirectory !== null;

  return {
    session: fallback ? projectDirectorySession(projectDirectory) : bound,
    root: fallback ? projectDirectory.path : undefined,
    isProjectDirectory: fallback,
    pinned: pinnedSession !== null,
    pin(sid: string) {
      uiState.update({ explorer_pin: sid });
    },
    unpin() {
      uiState.update({ explorer_pin: null });
    },
  };
}
