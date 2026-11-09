import { tabHoldsFile, type DesktopBufferSnapshot, type TabRef } from '@puddle/shared';
import { LazyEditorTabClose } from '../../editor/lazy-editor-parts';
import { tabCloseKey } from '../../workspace/tabs/close/TabCloseRequests';
import { tabRefKey } from '../../workspace/layout/layout-tree';
import { windowBufferKey } from '../state/content-state';
import { DraftRecovery } from './DraftRecovery';

/** Recover graph-owned buffers without a project lookup or a live huddle owner. */
export function HuddleRecovery({
  paneId,
  tab,
  drafts,
  onClose,
}: {
  paneId: string;
  tab: Extract<TabRef, { type: 'huddle' }>;
  drafts: readonly DesktopBufferSnapshot[];
  onClose: (signal?: AbortSignal) => void | Promise<boolean>;
}) {
  const held = drafts.filter((draft) => tabHoldsFile(tab, draft));
  const first = held[0];
  if (!first) return null;
  const label = `Huddle ${tab.session.slice(0, 8)}`;
  return (
    <section className="flex flex-col gap-3" aria-label={label}>
      <div className="flex items-center gap-2 text-sm">
        <span>{label}</span>
        <LazyEditorTabClose
          session={tab.session}
          path={first.path}
          relatedPaths={held.slice(1).map((draft) => draft.path)}
          kind="file"
          label={label}
          closeKey={tabCloseKey(paneId, tabRefKey(tab))}
          onClose={onClose}
        />
      </div>
      {held.map((draft) => (
        <DraftRecovery key={windowBufferKey(draft)} draft={draft} />
      ))}
    </section>
  );
}
