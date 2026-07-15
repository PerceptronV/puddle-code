import { TerminalSquare } from 'lucide-react';
import type { LayoutLeaf, Session, TabRef } from '@puddle/shared';
import { cn } from '../../lib/utils';
import { LazyPaneEditorBody } from '../editor/lazy-editor-parts';
import type { RevealTarget } from './editor-context';
import { useKeepAliveSlot } from './keep-alive';
import { PaneTabStrip } from './PaneTabStrip';
import { tabRefKey } from './layout-tree';

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
  onArchived,
  onFocusLeaf,
}: {
  leaf: LayoutLeaf;
  sessions: Session[];
  reveal: RevealTarget | null;
  onActivateTab: (leafId: string, ref: TabRef) => void;
  onCloseTab: (leafId: string, ref: TabRef) => void;
  onArchived: (session: string) => void;
  onFocusLeaf: (leafId: string) => void;
}) {
  const activeRef = leaf.tabs.find((t) => tabRefKey(t) === leaf.activeKey) ?? null;
  const terminalKey = activeRef?.type === 'terminal' ? tabRefKey(activeRef) : null;
  const slotRef = useKeepAliveSlot(terminalKey);

  return (
    <div className="flex h-full flex-col bg-ground" onMouseDownCapture={() => onFocusLeaf(leaf.id)}>
      <PaneTabStrip
        leaf={leaf}
        sessions={sessions}
        onActivate={(ref) => onActivateTab(leaf.id, ref)}
        onClose={(ref) => onCloseTab(leaf.id, ref)}
        onArchived={onArchived}
      />
      <div className="relative min-h-0 flex-1">
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
        {!activeRef && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <TerminalSquare className="size-8 text-fg-muted" />
            <p className="text-sm text-fg-secondary">
              {sessions.some((s) => s.status !== 'archived')
                ? 'Open a file, or pick a session from the sidebar.'
                : 'No sessions yet — press ⌘K to start one.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
