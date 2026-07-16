import { useDroppable } from '@dnd-kit/core';
import type { LayoutLeaf, Session, TabRef } from '@puddle/shared';
import { PuddleGlyph } from '../../components/puddle-glyph';
import { openCommandPalette } from '../../lib/command-palette';
import { cn } from '../../lib/utils';
import { LazyPaneEditorBody } from '../editor/lazy-editor-parts';
import type { RevealTarget } from './editor-context';
import { useKeepAliveSlot } from './keep-alive';
import { PaneTabStrip } from './PaneTabStrip';
import { tabRefKey, type DropEdge } from './layout-tree';
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
}: {
  leaf: LayoutLeaf;
  sessions: Session[];
  reveal: RevealTarget | null;
  onActivateTab: (leafId: string, ref: TabRef) => void;
  onCloseTab: (leafId: string, ref: TabRef) => void;
  onPromoteTab: (ref: TabRef) => void;
  onArchived: (session: string) => void;
  onFocusLeaf: (leafId: string) => void;
}) {
  const activeRef = leaf.tabs.find((t) => tabRefKey(t) === leaf.activeKey) ?? null;
  const terminalKey = activeRef?.type === 'terminal' ? tabRefKey(activeRef) : null;
  const slotRef = useKeepAliveSlot(terminalKey);
  const { setNodeRef } = useDroppable({ id: `leaf:${leaf.id}` });
  const indicator = useDropIndicator();

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
      <div ref={setNodeRef} className="relative min-h-0 flex-1">
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
        {indicator?.leafId === leaf.id && <DropZoneOverlay zone={indicator.zone} />}
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
