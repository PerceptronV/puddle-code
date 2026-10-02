import { Archive } from 'lucide-react';
import { toastError } from '../../lib/errors';
import { useArchiveSession } from '../../lib/queries';

/** The tab shortcut uses the same reversible archive mutation as the session menu. */
export function SessionArchiveButton({
  session,
  onArchived,
}: {
  session: string;
  onArchived: (session: string) => void;
}) {
  const archive = useArchiveSession();
  return (
    <button
      type="button"
      disabled={archive.isPending}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={async (event) => {
        event.stopPropagation();
        try {
          // An archived-session update can unmount this button before the
          // request settles. Await it so closing survives that unmount;
          // per-call mutate callbacks only run while the observer is mounted.
          await archive.mutateAsync(session);
          onArchived(session);
        } catch (error) {
          toastError(error);
        }
      }}
      className="hidden rounded-sm p-0.5 text-fg-muted transition-colors hover:text-fg disabled:cursor-wait disabled:opacity-50 group-hover:inline-flex pointer-coarse:inline-flex"
      aria-label="Archive session"
      title="Archive session"
    >
      <Archive className="size-3" />
    </button>
  );
}
