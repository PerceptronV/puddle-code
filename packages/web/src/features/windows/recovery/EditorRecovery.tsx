import { useCallback, useSyncExternalStore, type ReactNode } from 'react';
import { Button } from '../../../components/ui/button';
import { useWorktreeFile } from '../../../lib/queries/worktree-queries';
import { useUntitledFile } from '../../../lib/queries/untitled-queries';
import { useCurrentProfileId } from '../../profile/profile-store';
import { tabKind, type EditorTab } from '../../editor/tabs/editor-tabs';
import { desktopContentState } from '../state/content-state';
import { DraftRecovery } from './DraftRecovery';

/** Observe the existing editor query; add no reads or polling during ordinary editing. */
export function EditorRecovery({ tab, children }: { tab: EditorTab; children: ReactNode }) {
  const profile = useCurrentProfileId();
  const content = profile ? desktopContentState(profile) : null;
  const draft = useSyncExternalStore(
    useCallback((listener) => content?.subscribe(listener) ?? (() => {}), [content]),
    () => content?.buffer(tab),
  );
  const file = useWorktreeFile(tab.session, tab.path, { root: tab.root, enabled: false });
  const untitled = useUntitledFile(profile, tab.path, false);
  const query = tabKind(tab) === 'untitled' ? untitled : file;
  if (!draft || !query.error) return children;
  return (
    <div className="h-full overflow-auto p-4" role="region" aria-label="Recovered draft">
      <p className="mb-2 text-sm text-fg-muted">
        The original file or draft is unavailable. Your unsaved text is retained in this window.
      </p>
      <Button variant="ghost" onClick={() => void query.refetch()}>
        Retry original
      </Button>
      <DraftRecovery draft={draft} />
    </div>
  );
}
