import { tabHoldsFile } from '@puddle/shared';
import { useCurrentProfileId } from '../../profile/profile-store';
import { windowBufferKey } from '../state/content-state';
import { DraftRecovery } from './DraftRecovery';
import { useRetainedBuffers } from './use-retained-buffers';

/** The project can still exist after a graph's placement disappears. */
export function MissingHuddle({ session }: { session: string }) {
  const drafts = useRetainedBuffers(useCurrentProfileId());
  const held = drafts.filter((draft) => tabHoldsFile({ type: 'huddle', session }, draft));
  return (
    <div className="h-full overflow-auto p-4" role="region" aria-label="Unavailable huddle">
      <p className="mb-3 text-sm text-fg-muted">
        Huddle unavailable — this tab is retained for reconnection.
      </p>
      <div className="flex flex-col gap-4">
        {held.map((draft) => (
          <DraftRecovery key={windowBufferKey(draft)} draft={draft} />
        ))}
      </div>
    </div>
  );
}
