import { Button } from '../../../components/ui/button';
import {
  desktopPaneCloseReview,
  desktopPaneOrphanedBuffers,
  type TabRef,
  type UiStateSnapshot,
} from '@puddle/shared';
import { windowBufferKey } from '../state/content-state';
import { DraftRecovery } from './DraftRecovery';
import { useRetainedBuffers } from './use-retained-buffers';
import { OrphanedDraft } from './OrphanedDraft';
import { LazyEditorTabClose } from '../../editor/lazy-editor-parts';
import { tabKind } from '../../editor/tabs/editor-tabs';
import { tabCloseKey } from '../../workspace/tabs/close/TabCloseRequests';
import { tabRefKey } from '../../workspace/layout/layout-tree';

/** A failed project lookup cannot leave a native window blank or hide retained drafts. */
export function ProjectRecovery({
  profileId,
  snapshot,
  retry,
  onClose,
}: {
  profileId: string;
  snapshot: UiStateSnapshot;
  retry: () => void;
  onClose: (paneId: string, ref: TabRef, signal?: AbortSignal) => void | Promise<boolean>;
}) {
  const drafts = useRetainedBuffers(profileId);
  const content = { snapshot, buffers: [...drafts], views: {} };
  const { targets } = desktopPaneCloseReview(content);
  const orphaned = desktopPaneOrphanedBuffers(content);
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
        {targets.map(({ paneId, ref }) => {
          if (ref.type !== 'editor') return null;
          const draft = drafts.find((value) => windowBufferKey(value) === windowBufferKey(ref.tab));
          const close = (
            <LazyEditorTabClose
              session={ref.tab.session}
              path={ref.tab.path}
              root={ref.tab.root}
              kind={tabKind(ref.tab)}
              label={ref.tab.path}
              closeKey={tabCloseKey(paneId, tabRefKey(ref))}
              onClose={(signal) => onClose(paneId, ref, signal)}
            />
          );
          return draft ? (
            <DraftRecovery
              key={tabCloseKey(paneId, tabRefKey(ref))}
              draft={draft}
              actions={close}
            />
          ) : (
            <div
              key={tabCloseKey(paneId, tabRefKey(ref))}
              className="flex items-center gap-3 text-sm"
            >
              {ref.tab.path}
              {close}
            </div>
          );
        })}
        {orphaned.map((draft) => (
          <OrphanedDraft key={windowBufferKey(draft)} draft={draft} />
        ))}
      </div>
    </div>
  );
}
