import { useState, type DragEvent } from 'react';
import { useDroppable } from '@dnd-kit/core';
import type { LayoutLeaf, Session, TabRef } from '@puddle/shared';
import { PuddleGlyph } from '../../components/puddle-glyph';
import { openCommandPalette } from '../../lib/command-palette';
import { cn } from '../../lib/utils';
import { LazyPaneEditorBody } from '../editor/lazy-editor-parts';
import type { RevealTarget } from './editor-context';
import { useKeepAliveSlot } from './keep-alive';
import { zoneForPointer } from './layout-dnd';
import { PaneTabStrip } from './PaneTabStrip';
import { tabRefKey, type DropEdge } from './layout-tree';
import { decodeTabTransfer, hasTabTransfer, TAB_MIME } from './tab-transfer';
import { useDropIndicator } from './TilingDnd';

/**
 * One leaf pane (SPEC §8): its tab strip over a body that shows the active tab —
 * a terminal (its kept-alive DOM adopted into the slot) or an editor body (per
 * pane, sharing the refcounted model). Mousedown focuses the pane so opens and
 * keyboard actions target it. An empty leaf is the workspace's empty state.
 */
export function PaneLeaf({
  leaf,
  sessions,
  reveal,
  onActivateTab,
  onCloseTab,
  onPromoteTab,
  onArchived,
  onFocusLeaf,
  onDropTab,
}: {
  leaf: LayoutLeaf;
  sessions: Session[];
  reveal: RevealTarget | null;
  onActivateTab: (leafId: string, ref: TabRef) => void;
  onCloseTab: (leafId: string, ref: TabRef) => void;
  onPromoteTab: (ref: TabRef) => void;
  onArchived: (session: string) => void;
  onFocusLeaf: (leafId: string) => void;
  /** A sidebar drag (file row / session) dropped on this pane — open + position. */
  onDropTab: (leafId: string, ref: TabRef, edge: DropEdge) => void;
}) {
  const activeRef = leaf.tabs.find((t) => tabRefKey(t) === leaf.activeKey) ?? null;
  const terminalKey = activeRef?.type === 'terminal' ? tabRefKey(activeRef) : null;
  const slotRef = useKeepAliveSlot(terminalKey);
  const { setNodeRef } = useDroppable({ id: `leaf:${leaf.id}` });
  const indicator = useDropIndicator();

  // Native-DnD drop zone for sidebar drags (tab drags between panes ride
  // dnd-kit and the context indicator instead; the two never fire together).
  const [nativeZone, setNativeZone] = useState<DropEdge | null>(null);
  const zoneOf = (e: DragEvent<HTMLDivElement>): DropEdge => {
    const r = e.currentTarget.getBoundingClientRect();
    return zoneForPointer(
      { width: r.width, height: r.height },
      { x: e.clientX - r.left, y: e.clientY - r.top },
    );
  };

  return (
    <div className="flex h-full flex-col bg-ground" onMouseDownCapture={() => onFocusLeaf(leaf.id)}>
      {/* No tabs → no strip: an empty pane reserves no blank bar (HUMANS.md). */}
      {leaf.tabs.length > 0 && (
        <PaneTabStrip
          leaf={leaf}
          sessions={sessions}
          onActivate={(ref) => onActivateTab(leaf.id, ref)}
          onClose={(ref) => onCloseTab(leaf.id, ref)}
          onPromote={onPromoteTab}
          onArchived={onArchived}
        />
      )}
      {/* Clicking INTO the pane body (typing in its editor, clicking in its
          terminal) activates the shown tab exactly like clicking its strip
          chip — the left sidebar re-binds to that tab's worktree, and a
          terminal also claims the URL. Capture phase, so xterm/Monaco still
          receive the event untouched. */}
      <div
        ref={setNodeRef}
        className="relative min-h-0 flex-1"
        onMouseDownCapture={() => activeRef && onActivateTab(leaf.id, activeRef)}
        onDragOver={(e) => {
          if (!hasTabTransfer(e.dataTransfer.types)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setNativeZone(zoneOf(e));
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setNativeZone(null);
        }}
        onDrop={(e) => {
          if (!hasTabTransfer(e.dataTransfer.types)) return;
          e.preventDefault();
          setNativeZone(null);
          const ref = decodeTabTransfer(e.dataTransfer.getData(TAB_MIME));
          if (ref) onDropTab(leaf.id, ref, zoneOf(e));
        }}
      >
        {activeRef?.type === 'editor' && (
          <div className="absolute inset-0">
            <LazyPaneEditorBody tab={activeRef.tab} reveal={reveal} />
          </div>
        )}
        {/* The keep-alive slot is always mounted (stable ref) so a terminal
            container can be adopted into it; hidden when no terminal is active. */}
        <div
          ref={slotRef}
          className={cn('absolute inset-0 py-1 pl-4 pr-2', !terminalKey && 'hidden')}
        />
        {/* A strip insertion (index set) is marked by the strip's caret instead
            of the pane-body highlight. */}
        {indicator?.leafId === leaf.id && indicator.index === undefined && (
          <DropZoneOverlay zone={indicator.zone} />
        )}
        {nativeZone !== null && <DropZoneOverlay zone={nativeZone} />}
        {!activeRef && (
          <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
            <PuddleGlyph className="size-24 text-fg-muted/40" />
            <button
              type="button"
              onClick={openCommandPalette}
              className="rounded-md bg-elevated px-3 py-1.5 font-mono text-xs text-fg-muted transition-colors hover:bg-border hover:text-fg-secondary"
            >
              ⌘K
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const ZONE_POS: Record<DropEdge, string> = {
  center: 'inset-0',
  left: 'inset-y-0 left-0 w-1/2',
  right: 'inset-y-0 right-0 w-1/2',
  top: 'inset-x-0 top-0 h-1/2',
  bottom: 'inset-x-0 bottom-0 h-1/2',
};

/** Translucent highlight of the region a drop will land in (SPEC §8). */
function DropZoneOverlay({ zone }: { zone: DropEdge }) {
  return <div className={cn('pointer-events-none absolute z-20 bg-accent/20', ZONE_POS[zone])} />;
}
