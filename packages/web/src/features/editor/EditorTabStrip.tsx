import { useCallback, useState, useSyncExternalStore } from 'react';
import { Circle, X } from 'lucide-react';
import type { Session } from '@puddle/shared';
import { cn } from '../../lib/utils';
import { bufferKey, editorTabLabel, isDirty, subscribe, type OpenTab } from './buffer-store';
import { sameTab, type EditorTab } from './editor-tabs';

/** Reactive dirty flag for one (session, path) buffer. */
function useDirty(session: string, path: string): boolean {
  const key = bufferKey(session, path);
  return useSyncExternalStore(
    useCallback((cb: () => void) => subscribe(key, cb), [key]),
    () => isDirty(key),
  );
}

function TabItem({
  tab,
  label,
  active,
  dragging,
  onActivate,
  onClose,
  onDragStart,
  onDragEnd,
  onDragOver,
}: {
  tab: EditorTab;
  label: string;
  active: boolean;
  dragging: boolean;
  onActivate(): void;
  onClose(): void;
  onDragStart(): void;
  onDragEnd(): void;
  onDragOver(): void;
}) {
  const dirty = useDirty(tab.session, tab.path);
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver();
      }}
      onClick={onActivate}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault(); // middle-click closes
          onClose();
        }
      }}
      className={cn(
        'group flex min-w-0 max-w-52 cursor-pointer items-center gap-1.5 rounded-t-md px-2.5 text-xs transition-colors',
        active ? 'bg-ground text-fg' : 'text-fg-secondary hover:bg-elevated',
        dragging && 'opacity-50',
      )}
    >
      <span className="truncate font-mono">{label}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="flex size-4 items-center justify-center rounded-sm text-fg-muted transition-colors hover:text-fg"
        aria-label={`Close ${label}`}
      >
        {dirty ? (
          <>
            <Circle className="size-2 fill-current group-hover:hidden" />
            <X className="hidden size-3 group-hover:block" />
          </>
        ) : (
          <X className="size-3 opacity-0 group-hover:opacity-100" />
        )}
      </button>
    </div>
  );
}

/**
 * Editor tabs: one per open (session, path). Labels disambiguate by branch
 * and/or full path via `editorTabLabel` (SPEC §8). Mono labels, a dirty dot
 * that becomes a close × on hover, drag to reorder, middle-click to close.
 */
export function EditorTabStrip({
  tabs,
  activeTab,
  sessions,
  onActivate,
  onClose,
  onReorder,
}: {
  tabs: EditorTab[];
  activeTab: EditorTab | null;
  sessions: Session[];
  onActivate(tab: EditorTab): void;
  onClose(tab: EditorTab): void;
  onReorder(tabs: EditorTab[]): void;
}) {
  const [dragging, setDragging] = useState<EditorTab | null>(null);

  if (tabs.length === 0) return null;

  const sessionBranches = new Map(sessions.map((s) => [s.id, s.branch]));
  const openTabs: OpenTab[] = tabs;

  const move = (from: EditorTab, to: EditorTab) => {
    if (sameTab(from, to)) return;
    const next = tabs.filter((t) => !sameTab(t, from));
    next.splice(
      next.findIndex((t) => sameTab(t, to)),
      0,
      from,
    );
    onReorder(next);
  };

  return (
    <div className="flex h-9 shrink-0 items-stretch gap-0.5 overflow-x-auto bg-surface px-1 pt-1">
      {tabs.map((tab) => (
        <TabItem
          key={`${tab.session}:${tab.path}`}
          tab={tab}
          label={editorTabLabel(tab.path, tab.session, openTabs, sessionBranches)}
          active={activeTab !== null && sameTab(activeTab, tab)}
          dragging={dragging !== null && sameTab(dragging, tab)}
          onActivate={() => onActivate(tab)}
          onClose={() => onClose(tab)}
          onDragStart={() => setDragging(tab)}
          onDragEnd={() => setDragging(null)}
          onDragOver={() => dragging && move(dragging, tab)}
        />
      ))}
    </div>
  );
}
