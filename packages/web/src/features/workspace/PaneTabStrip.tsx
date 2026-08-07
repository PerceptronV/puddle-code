import { Fragment, type ReactNode } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { Eye, FileCode, X } from 'lucide-react';
import type { LayoutLeaf, Session, TabRef } from '@puddle/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { cn } from '../../lib/utils';
import { useSessionTitleRenderer } from '../profile/use-session-title';
import { SessionGlyph } from '../status/SessionGlyph';
import { editorTabLabel } from '../editor/buffer-logic';
import { tabKind, type EditorTab } from '../editor/editor-tabs';
import { LazyEditorDirtyDot, LazyEditorTabClose } from '../editor/lazy-editor-parts';
import { previewKind } from '../editor/preview-kind';
import { SessionContextMenu } from './SessionActions';
import { TabTooltipBody } from './TabTooltip';
import { tabRefKey } from './layout-tree';
import { useDropIndicator } from './TilingDnd';

// `min-w-16` (64px) is exactly the room the hover controls need and no more:
// measured, not guessed — the preview + close cluster is 49.4px wide and the
// chip carries 11px of left padding. A chip never shrinks below the icons it
// may show, and never grows to accommodate them either, since they overlay the
// right edge rather than sitting in the flow (see TabControls). `relative`
// anchors them; `max-w-52` still caps a long title, which truncates as before.
// `select-none`: a chip's double-click PROMOTES the tab (below), and the
// browser's own double-click default would also select the title's word — the
// tab would be left with a highlighted filename nobody asked to select and no
// way to copy it from anyway.
const TAB_CLASS =
  'group relative flex min-w-16 max-w-52 cursor-pointer select-none items-center gap-1.5 rounded-t-md px-2.5 text-xs transition-colors';

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
  onSetView,
  onNewFile,
}: {
  leaf: LayoutLeaf;
  sessions: Session[];
  onActivate: (ref: TabRef) => void;
  onClose: (ref: TabRef) => void;
  onPromote: (ref: TabRef) => void;
  onArchived: (session: string) => void;
  /** Flip a previewable editor tab between Monaco source and rendered preview (SPEC §8). */
  onSetView: (ref: TabRef, view: 'source' | 'preview') => void;
  /** Double-click on the strip's blank tail: open a fresh untitled file (SPEC §8). */
  onNewFile: () => void;
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
      // Blank space only: a double-click on a tab bubbles here with the tab
      // as the target, and that gesture is already "promote to permanent".
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) onNewFile();
      }}
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
            // The worktree a FILE tab belongs to, for its hover tooltip. A tab
            // carrying a `root` is rooted outside the worktree (a browse-tree
            // `external` file) and an untitled draft's session is the nil uuid,
            // so neither resolves — and neither describes a worktree.
            fileSession={
              ref.type === 'editor' && ref.tab.root === undefined
                ? sessions.find((s) => s.id === ref.tab.session)
                : undefined
            }
            label={ref.type === 'editor' ? labelFor(ref.tab) : ''}
            onActivate={() => onActivate(ref)}
            onClose={() => onClose(ref)}
            onPromote={() => onPromote(ref)}
            onArchived={onArchived}
            onSetView={(view) => onSetView(ref, view)}
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

/**
 * The chip's trailing controls, laid OVER the title rather than beside it.
 *
 * In flow they widened a short chip on hover — and shoved every tab after it
 * along — while a chip already at `max-w-52` merely truncated instead, so the
 * same gesture did two different things depending on how long the filename
 * was. Absolutely positioned, they cost no width at all, so every chip keeps a
 * fixed size and only the title underneath is masked.
 *
 * The background comes in only on hover, so a clean tab at rest is still
 * exactly its title with nothing trailing it (HUMANS.md). It fades in from the
 * left rather than starting as a hard edge, so a truncated title slides under
 * the icons instead of being chopped. It also carries the chip's own
 * `rounded-tr-md`: laid over the chip's top-right corner, a square overlay
 * squared the tab off the moment it was hovered.
 */
function TabControls({ active, children }: { active: boolean; children: ReactNode }) {
  const fade = active
    ? 'group-hover:bg-[linear-gradient(to_right,transparent,var(--color-ground)_1.25rem)]'
    : 'group-hover:bg-[linear-gradient(to_right,transparent,var(--color-elevated)_1.25rem)]';
  return (
    <span
      className={cn(
        'pointer-events-none absolute inset-y-0 right-0 flex items-center gap-1 rounded-tr-md pl-5 pr-2.5',
        // Only the controls themselves take clicks; the masked title beneath
        // stays draggable and clickable like the rest of the chip.
        '[&>*]:pointer-events-auto',
        fade,
      )}
    >
      {children}
    </span>
  );
}

/**
 * The markdown/HTML tab's source ⇄ preview toggle (SPEC §8) — appears on
 * hover like the close button, styled identically (no borders, HUMANS.md).
 */
function ViewToggle({
  view,
  onSetView,
}: {
  view: 'source' | 'preview';
  onSetView: (view: 'source' | 'preview') => void;
}) {
  const showingPreview = view === 'preview';
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onSetView(showingPreview ? 'source' : 'preview');
      }}
      className="hidden rounded-sm p-0.5 text-fg-muted transition-colors hover:text-fg group-hover:inline-flex pointer-coarse:inline-flex"
      aria-label={showingPreview ? 'Show source' : 'Show preview'}
      title={showingPreview ? 'Show source' : 'Show preview'}
    >
      {showingPreview ? <FileCode className="size-3" /> : <Eye className="size-3" />}
    </button>
  );
}

function PaneTab({
  tab,
  leafId,
  index,
  active,
  preview,
  session,
  fileSession,
  label,
  onActivate,
  onClose,
  onPromote,
  onArchived,
  onSetView,
}: {
  tab: TabRef;
  leafId: string;
  index: number;
  active: boolean;
  preview: boolean;
  session: Session | undefined;
  /** An editor tab's own worktree session, when it has one (see the tooltip). */
  fileSession: Session | undefined;
  label: string;
  onActivate: () => void;
  onClose: () => void;
  onPromote: () => void;
  onArchived: (session: string) => void;
  onSetView: (view: 'source' | 'preview') => void;
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
          {/* One glyph for both facts: which agent, in the status colour. */}
          {session && (
            <SessionGlyph
              status={session.status}
              kind={session.kind}
              agentType={session.agent_type}
              stale={session.stale_running}
            />
          )}
          <span className="truncate">
            {session ? renderTitle(session) : tab.session.slice(0, 8)}
          </span>
          <TabControls active={active}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              className="hidden rounded-sm p-0.5 text-fg-muted transition-colors hover:text-fg group-hover:inline-flex pointer-coarse:inline-flex"
              aria-label="Close tab"
            >
              <X className="size-3" />
            </button>
          </TabControls>
        </>
      ) : (
        <>
          <span className="min-w-0 truncate">{label}</span>
          {/* In flow AFTER the filename — the chip widens for it (to its cap;
              past that the name truncates), and it never occludes the name.
              Hidden on hover, where the overlay × appears. */}
          <LazyEditorDirtyDot
            session={tab.tab.session}
            path={tab.tab.path}
            kind={tabKind(tab.tab)}
            root={tab.tab.root}
          />
          <TabControls active={active}>
            {/* `external` tabs render the same views (SPEC §8) — only diffs,
                commits, and untitled drafts have no rendered counterpart. */}
            {(tabKind(tab.tab) === 'file' || tabKind(tab.tab) === 'external') &&
              previewKind(tab.tab.path) !== null && (
                <ViewToggle view={tab.tab.view ?? 'source'} onSetView={onSetView} />
              )}
            <LazyEditorTabClose
              session={tab.tab.session}
              path={tab.tab.path}
              kind={tabKind(tab.tab)}
              root={tab.tab.root}
              label={label}
              onClose={onClose}
            />
          </TabControls>
        </>
      )}
    </div>
  );

  // The hover tooltip opens BELOW the chip, into the pane's own body: a strip
  // sits at the top of its pane, so upwards it would cover the strip above it —
  // or, in the first pane, the window's traffic lights.
  const tooltip = (
    <TooltipContent side="bottom">
      <TabTooltipBody
        name={tab.type === 'terminal' ? (session ? renderTitle(session) : tab.session) : label}
        session={tab.type === 'terminal' ? session : fileSession}
      />
    </TooltipContent>
  );

  // Both triggers stack on the chip itself (as the collapsed rail's dots do):
  // `asChild` needs a DOM element, so the tooltip trigger goes INSIDE the
  // context-menu trigger rather than wrapping it.
  if (tab.type === 'terminal' && session) {
    return (
      <Tooltip>
        <SessionContextMenu session={session} onArchived={() => onArchived(tab.session)}>
          <TooltipTrigger asChild>{body}</TooltipTrigger>
        </SessionContextMenu>
        {tooltip}
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      {tooltip}
    </Tooltip>
  );
}
