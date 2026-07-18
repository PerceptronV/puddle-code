import { Fragment } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
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
import { useDropIndicator } from './TilingDnd';

const TAB_CLASS =
  'group flex min-w-0 max-w-52 cursor-pointer items-center gap-1.5 rounded-t-md px-2.5 text-xs transition-colors';

/**
 * A tiling pane's tab strip (SPEC §8) — one unified strip over BOTH terminal and
 * editor tabs (merging the old `TabStrip` + `EditorTabStrip`). Each tab is
 * draggable (dnd-kit) so it can be reordered within the strip (each chip and the
 * strip's tail are droppables resolving to an insertion index, marked by a
 * caret) or dropped onto another pane to move into or split it; terminals carry
 * the session lifecycle menu, editors a dirty-aware close (behind the lazy
 * editor chunk).
 */
export function PaneTabStrip({
  leaf,
  sessions,
  onActivate,
  onClose,
  onPromote,
  onArchived,
}: {
  leaf: LayoutLeaf;
  sessions: Session[];
  onActivate: (ref: TabRef) => void;
  onClose: (ref: TabRef) => void;
  onPromote: (ref: TabRef) => void;
  onArchived: (session: string) => void;
}) {
  const branches = new Map(sessions.map((s) => [s.id, s.branch]));
  const editorTabs = leaf.tabs.flatMap((t) => (t.type === 'editor' ? [t.tab] : []));
  const indicator = useDropIndicator();
  const caretAt =
    indicator?.leafId === leaf.id && indicator.index !== undefined ? indicator.index : null;
  // The strip itself (its tail, past the last chip) drops as "append".
  const { setNodeRef: setStripRef } = useDroppable({
    id: `strip:${leaf.id}`,
    data: { leafId: leaf.id, count: leaf.tabs.length },
  });

  const labelFor = (tab: EditorTab): string => {
    const base = editorTabLabel(tab.path, tab.session, editorTabs, branches);
    if (tabKind(tab) === 'diff') return `${base} (diff)`;
    if (tabKind(tab) === 'commit') return `${base} @${(tab.sha ?? '').slice(0, 7)}`;
    return base;
  };

  return (
    <div
      ref={setStripRef}
      className="flex h-9 shrink-0 items-stretch gap-0.5 overflow-x-auto bg-surface px-1 pt-1"
    >
      {leaf.tabs.map((ref, index) => (
        <Fragment key={tabRefKey(ref)}>
          {caretAt === index && <InsertionCaret />}
          <PaneTab
            tab={ref}
            leafId={leaf.id}
            index={index}
            active={tabRefKey(ref) === leaf.activeKey}
            preview={tabRefKey(ref) === leaf.previewKey}
            session={
              ref.type === 'terminal' ? sessions.find((s) => s.id === ref.session) : undefined
            }
            label={ref.type === 'editor' ? labelFor(ref.tab) : ''}
            onActivate={() => onActivate(ref)}
            onClose={() => onClose(ref)}
            onPromote={() => onPromote(ref)}
            onArchived={onArchived}
          />
        </Fragment>
      ))}
      {caretAt === leaf.tabs.length && <InsertionCaret />}
    </div>
  );
}

/** The live insertion marker a strip drag will drop the tab at. */
function InsertionCaret() {
  return <div className="w-0.5 shrink-0 self-stretch rounded-full bg-accent" />;
}

function PaneTab({
  tab,
  leafId,
  index,
  active,
  preview,
  session,
  label,
  onActivate,
  onClose,
  onPromote,
  onArchived,
}: {
  tab: TabRef;
  leafId: string;
  index: number;
  active: boolean;
  preview: boolean;
  session: Session | undefined;
  label: string;
  onActivate: () => void;
  onClose: () => void;
  onPromote: () => void;
  onArchived: (session: string) => void;
}) {
  const renderTitle = useSessionTitleRenderer();
  const key = tabRefKey(tab);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    // Keyed by leaf too: legacy trees may hold the same tab in two panes, and
    // duplicate draggable ids confuse dnd-kit.
    id: `drag:${leafId}:${key}`,
    data: { ref: tab, fromLeafId: leafId },
  });
  // The chip is also a drop target, resolving to insert-before/after itself.
  const { setNodeRef: setDropRef } = useDroppable({
    id: `tabdrop:${leafId}:${key}`,
    data: { leafId, index },
  });
  const setRefs = (el: HTMLElement | null) => {
    setNodeRef(el);
    setDropRef(el);
  };
  const cls = cn(
    TAB_CLASS,
    active ? 'bg-ground text-fg' : 'text-fg-secondary hover:bg-elevated',
    // A preview (ephemeral) tab reads as italic, like VSCode — it will be
    // replaced by the next single-click open until a double-click pins it.
    preview && 'italic',
    isDragging && 'opacity-40',
  );

  const body = (
    <div
      ref={setRefs}
      {...attributes}
      {...listeners}
      onClick={onActivate}
      onDoubleClick={onPromote}
      className={cls}
    >
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
