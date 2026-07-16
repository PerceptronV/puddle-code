import { useDraggable } from '@dnd-kit/core';
import { X } from 'lucide-react';
import type { LayoutLeaf, Session, TabRef } from '@puddle/shared';
import { cn } from '../../lib/utils';
import { useSessionTitleRenderer } from '../profile/use-session-title';
import { StatusDot } from '../status/StatusDot';
import { editorTabLabel } from '../editor/buffer-logic';
import { tabKind, type EditorTab } from '../editor/editor-tabs';
import { LazyEditorTabClose } from '../editor/lazy-editor-parts';
import { SessionContextMenu } from './SessionActions';
import { tabRefKey } from './layout-tree';

const TAB_CLASS =
  'group flex min-w-0 max-w-52 cursor-pointer items-center gap-1.5 rounded-t-md px-2.5 text-xs transition-colors';

/**
 * A tiling pane's tab strip (SPEC §8) — one unified strip over BOTH terminal and
 * editor tabs (merging the old `TabStrip` + `EditorTabStrip`). Each tab is
 * draggable (dnd-kit) so it can be reordered or dropped onto another pane to
 * split it; terminals carry the session lifecycle menu, editors a dirty-aware
 * close (behind the lazy editor chunk).
 */
export function PaneTabStrip({
  leaf,
  sessions,
  onActivate,
  onClose,
  onArchived,
}: {
  leaf: LayoutLeaf;
  sessions: Session[];
  onActivate: (ref: TabRef) => void;
  onClose: (ref: TabRef) => void;
  onArchived: (session: string) => void;
}) {
  const branches = new Map(sessions.map((s) => [s.id, s.branch]));
  const editorTabs = leaf.tabs.flatMap((t) => (t.type === 'editor' ? [t.tab] : []));

  const labelFor = (tab: EditorTab): string => {
    const base = editorTabLabel(tab.path, tab.session, editorTabs, branches);
    if (tabKind(tab) === 'diff') return `${base} (diff)`;
    if (tabKind(tab) === 'commit') return `${base} @${(tab.sha ?? '').slice(0, 7)}`;
    return base;
  };

  return (
    <div className="flex h-9 shrink-0 items-stretch gap-0.5 overflow-x-auto bg-surface px-1 pt-1">
      {leaf.tabs.map((ref) => (
        <PaneTab
          key={tabRefKey(ref)}
          tab={ref}
          leafId={leaf.id}
          active={tabRefKey(ref) === leaf.activeKey}
          session={ref.type === 'terminal' ? sessions.find((s) => s.id === ref.session) : undefined}
          label={ref.type === 'editor' ? labelFor(ref.tab) : ''}
          onActivate={() => onActivate(ref)}
          onClose={() => onClose(ref)}
          onArchived={onArchived}
        />
      ))}
    </div>
  );
}

function PaneTab({
  tab,
  leafId,
  active,
  session,
  label,
  onActivate,
  onClose,
  onArchived,
}: {
  tab: TabRef;
  leafId: string;
  active: boolean;
  session: Session | undefined;
  label: string;
  onActivate: () => void;
  onClose: () => void;
  onArchived: (session: string) => void;
}) {
  const renderTitle = useSessionTitleRenderer();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: tabRefKey(tab),
    data: { ref: tab, fromLeafId: leafId },
  });
  const cls = cn(
    TAB_CLASS,
    active ? 'bg-ground text-fg' : 'text-fg-secondary hover:bg-elevated',
    isDragging && 'opacity-40',
  );

  const body = (
    <div ref={setNodeRef} {...attributes} {...listeners} onClick={onActivate} className={cls}>
      {tab.type === 'terminal' ? (
        <>
          {session && <StatusDot status={session.status} kind={session.kind} />}
          <span className="truncate font-mono">
            {session ? renderTitle(session) : tab.session.slice(0, 8)}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="rounded-sm p-0.5 text-fg-muted opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
            aria-label="Close tab"
          >
            <X className="size-3" />
          </button>
        </>
      ) : (
        <>
          <span className="truncate font-mono">{label}</span>
          <LazyEditorTabClose
            session={tab.tab.session}
            path={tab.tab.path}
            kind={tabKind(tab.tab)}
            label={label}
            onClose={onClose}
          />
        </>
      )}
    </div>
  );

  if (tab.type === 'terminal' && session) {
    return (
      <SessionContextMenu session={session} onArchived={() => onArchived(tab.session)}>
        {body}
      </SessionContextMenu>
    );
  }
  return body;
}
