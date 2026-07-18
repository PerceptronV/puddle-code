import type { Session } from '@puddle/shared';
import type { UiStateHandle } from '../workspace/use-ui-state';

export interface ExplorerTarget {
  /** The worktree the whole left sidebar is bound to; null when nothing qualifies. */
  session: Session | null;
  /** Whether `session` is locked via `explorer_pin`, as opposed to following the active tab. */
  pinned: boolean;
  pin(sid: string): void;
  unpin(): void;
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
 */
export function useExplorerTarget(
  sessions: Session[],
  boundSessionId: string | null,
  uiState: UiStateHandle,
): ExplorerTarget {
  const pinnedId = uiState.snapshot.explorer_pin;
  const pinnedSession =
    pinnedId !== null
      ? (sessions.find((s) => s.id === pinnedId && s.status !== 'archived') ?? null)
      : null;

  const session = pinnedSession ?? sessions.find((s) => s.id === boundSessionId) ?? null;

  return {
    session,
    pinned: pinnedSession !== null,
    pin(sid: string) {
      uiState.update({ explorer_pin: sid });
    },
    unpin() {
      uiState.update({ explorer_pin: null });
    },
  };
}
