import { Button } from '../../../components/ui/button';
import { desktopContentState, windowBufferKey } from '../state/content-state';
import { DraftRecovery } from './DraftRecovery';

/** A failed project lookup cannot leave a native window blank or hide retained drafts. */
export function ProjectRecovery({ profileId, retry }: { profileId: string; retry: () => void }) {
  const drafts = desktopContentState(profileId).capture().buffers;
  return (
    <div className="h-full overflow-auto p-4" role="region" aria-label="Unavailable project">
      <h1 className="text-sm">Project unavailable</h1>
      <p className="my-2 text-sm text-fg-muted">
        This window’s saved tabs and drafts are retained. Retry when the project is available.
      </p>
      <Button variant="ghost" onClick={retry}>
        Retry project
      </Button>
      <div className="mt-4 flex flex-col gap-4">
        {drafts.map((draft) => (
          <DraftRecovery key={windowBufferKey(draft)} draft={draft} />
        ))}
      </div>
    </div>
  );
}
