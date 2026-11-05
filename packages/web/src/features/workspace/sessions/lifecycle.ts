import type { Session } from '@puddle/shared';

/** Session eligibility only; callers retain transport, pending and presentation state. */
export function sessionLifecycle(
  session: Pick<Session, 'status' | 'worktree_missing' | 'conversation_missing'>,
) {
  const live =
    session.status === 'starting' ||
    session.status === 'running' ||
    session.status === 'waiting_input';
  const archived = session.status === 'archived';
  const resumeUnavailable = session.worktree_missing
    ? 'Worktree directory is gone — resume unavailable'
    : session.conversation_missing
      ? 'Native conversation is missing — resume unavailable'
      : undefined;
  return {
    live,
    archived,
    resumable:
      (session.status === 'exited' || session.status === 'interrupted') && !resumeUnavailable,
    resumeUnavailable,
  };
}
