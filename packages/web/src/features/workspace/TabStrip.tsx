import { useState } from 'react';
import { X } from 'lucide-react';
import type { Session } from '@puddle/shared';
import { cn } from '../../lib/utils';
import { StatusDot } from '../status/StatusDot';

/** Open session tabs: click to activate, drag to reorder, × to close. */
export function TabStrip({
  tabs,
  sessions,
  activeId,
  onActivate,
  onClose,
  onReorder,
}: {
  tabs: string[];
  sessions: Session[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (tabs: string[]) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);

  if (tabs.length === 0) return null;

  const move = (id: string, before: string) => {
    if (id === before) return;
    const next = tabs.filter((t) => t !== id);
    next.splice(next.indexOf(before), 0, id);
    onReorder(next);
  };

  return (
    <div className="flex h-9 shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-border bg-surface px-1 pt-1">
      {tabs.map((id) => {
        const session = sessions.find((s) => s.id === id);
        if (!session) return null;
        return (
          <div
            key={id}
            draggable
            onDragStart={() => setDragging(id)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragging && dragging !== id) move(dragging, id);
            }}
            onClick={() => onActivate(id)}
            className={cn(
              'group flex min-w-0 max-w-52 cursor-default items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-xs',
              id === activeId
                ? 'border-border bg-ground text-fg'
                : 'border-transparent text-fg-secondary hover:bg-elevated',
              dragging === id && 'opacity-50',
            )}
          >
            <StatusDot status={session.status} />
            <span className="truncate font-mono">{session.title ?? session.id.slice(0, 8)}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(id);
              }}
              className="rounded-sm p-0.5 text-fg-muted opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
            >
              <X className="size-3" />
              <span className="sr-only">Close tab</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
