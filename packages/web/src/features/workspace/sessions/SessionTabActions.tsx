import type { Session } from '@puddle/shared';
import { Archive, Play, Square } from 'lucide-react';
import { useNavigate } from 'react-router';
import { liveConversationTarget, toastError } from '../../../lib/transport/errors';
import { useArchiveSession, useSessionAction } from '../../../lib/queries/queries';
import { sessionLifecycle } from './lifecycle';

const BUTTON_CLASS =
  'inline-flex rounded-sm p-0.5 text-fg-muted transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-50';

/** Tab shortcuts share the session menu's stop, resume and archive mutations. */
export function SessionTabActions({
  session,
  onArchived,
}: {
  session: Session;
  onArchived: (session: string) => void;
}) {
  const { live, archived, resumable, resumeUnavailable } = sessionLifecycle(session);
  const action = useSessionAction(live ? 'kill' : 'resume');
  const archive = useArchiveSession();
  const navigate = useNavigate();
  const pending = action.isPending || archive.isPending;
  if (archived) return null;

  return (
    <>
      {(session.kind !== 'huddle' || live) && (
        <button
          type="button"
          disabled={pending || (!live && !resumable)}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={async (event) => {
            event.stopPropagation();
            try {
              await action.mutateAsync(session.id);
            } catch (error) {
              const target = !live && liveConversationTarget(error);
              if (target) {
                void navigate(`/project/${target.projectId}/session/${target.sessionId}`);
              } else {
                toastError(error);
              }
            }
          }}
          className={BUTTON_CLASS}
          aria-label={live ? 'Stop session' : 'Resume session'}
          title={live ? 'Stop session' : (resumeUnavailable ?? 'Resume session')}
        >
          {live ? <Square className="size-3" /> : <Play className="size-3" />}
        </button>
      )}
      {!live && (
        <button
          type="button"
          disabled={pending}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={async (event) => {
            event.stopPropagation();
            try {
              // An archived-session update can unmount this button before the
              // request settles. Await it so closing survives that unmount;
              // per-call mutate callbacks only run while the observer is mounted.
              await archive.mutateAsync(session.id);
              onArchived(session.id);
            } catch (error) {
              toastError(error);
            }
          }}
          className={BUTTON_CLASS}
          aria-label="Archive session"
          title="Archive session"
        >
          <Archive className="size-3" />
        </button>
      )}
    </>
  );
}
