import type { ReactNode } from 'react';
import { desktopPaneOrphanedBuffers, type UiStateSnapshot } from '@puddle/shared';
import { desktopWindowContext } from '../window-context';
import { windowBufferKey } from '../state/content-state';
import { useRetainedBuffers } from './use-retained-buffers';
import { OrphanedDraft } from './OrphanedDraft';

/** Keep the existing workspace mounted while exposing drafts without a tab. */
export function NativeWindowRecovery({
  profileId,
  ...props
}: {
  profileId?: string;
  snapshot: UiStateSnapshot;
  children: ReactNode;
}) {
  if (!profileId || !desktopWindowContext()) return props.children;
  return <ProfileRecovery profileId={profileId} {...props} />;
}

function ProfileRecovery({
  profileId,
  snapshot,
  children,
}: {
  profileId: string;
  snapshot: UiStateSnapshot;
  children: ReactNode;
}) {
  const buffers = useRetainedBuffers(profileId);
  const orphaned = desktopPaneOrphanedBuffers({ snapshot, buffers: [...buffers], views: {} });
  return (
    <div className="flex h-full min-h-0 flex-col">
      {orphaned.length > 0 && (
        <details open className="max-h-[45%] shrink-0 overflow-auto p-3">
          <summary className="cursor-pointer text-sm">Recovered drafts</summary>
          <p className="my-2 text-sm text-fg-muted">
            These retained copies no longer have tabs. Copy, download or discard them here.
          </p>
          <div className="flex flex-col gap-4">
            {orphaned.map((draft) => (
              <OrphanedDraft key={windowBufferKey(draft)} draft={draft} />
            ))}
          </div>
        </details>
      )}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
