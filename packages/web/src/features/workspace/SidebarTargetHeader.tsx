import { ChevronDown, Pin } from 'lucide-react';
import type { Session } from '@puddle/shared';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { cn } from '../../lib/utils';
import type { ExplorerTarget } from '../explorer/use-explorer-target';

/**
 * The left sidebar's bound-worktree header (SPEC §8), shown under the icon row
 * for every navigator (Files, Changes, Search) now that the pin applies across
 * all of them: it names the bound worktree's branch, carries the pin toggle,
 * and offers a dropdown to pin any other project worktree by hand. The pin sits
 * here (left of the dropdown) to keep the icon row uncluttered; picking a
 * worktree in the dropdown pins it directly.
 */
export function SidebarTargetHeader({
  sessions,
  target,
}: {
  sessions: Session[];
  target: ExplorerTarget;
}) {
  const { session, pinned, pin, unpin } = target;
  const pickable = sessions.filter((s) => s.status !== 'archived');

  return (
    <div className="flex h-8 shrink-0 items-center gap-1 px-2">
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-secondary">
        {session ? session.branch || session.title || session.id.slice(0, 8) : 'No worktree'}
      </span>
      <button
        type="button"
        aria-pressed={pinned}
        disabled={!session}
        title={pinned ? 'Unpin — follow the active session' : 'Pin the sidebar to this worktree'}
        onClick={() => (pinned ? unpin() : session && pin(session.id))}
        className={cn(
          'rounded-sm p-1 transition-colors disabled:pointer-events-none disabled:opacity-40',
          pinned ? 'text-fg' : 'text-fg-muted hover:bg-elevated hover:text-fg',
        )}
      >
        <Pin className={cn('size-3.5', pinned && 'fill-current')} />
        <span className="sr-only">{pinned ? 'Unpin sidebar' : 'Pin sidebar'}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title="Bind a different worktree"
            className="rounded-sm p-1 text-fg-muted transition-colors hover:bg-elevated hover:text-fg"
          >
            <ChevronDown className="size-3.5" />
            <span className="sr-only">Choose a worktree</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {pickable.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-fg-muted">No sessions yet</div>
          ) : (
            pickable.map((s) => (
              <DropdownMenuItem key={s.id} onSelect={() => pin(s.id)}>
                <span className="truncate font-mono">
                  {s.branch} — {s.title ?? s.id.slice(0, 8)}
                </span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
