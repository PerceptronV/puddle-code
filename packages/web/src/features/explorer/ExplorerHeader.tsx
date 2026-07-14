import { ChevronDown, Pin, PinOff } from 'lucide-react';
import type { Session } from '@puddle/shared';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import type { ExplorerTarget } from './use-explorer-target';

/**
 * Compact explorer header (SPEC §8): the bound worktree's branch (falling
 * back to its title, then its id), a pin toggle, and a dropdown for pinning
 * any of the project's other sessions by hand. Unpinning resumes
 * follow-the-active-session (`useExplorerTarget` handles the re-derivation).
 */
export function ExplorerHeader({
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
        onClick={() => {
          if (pinned) unpin();
          else if (session) pin(session.id);
        }}
        title={pinned ? 'Unpin — follow the active session' : 'Pin the explorer to this worktree'}
        className="rounded-sm p-1 text-fg-muted transition-colors hover:bg-elevated hover:text-fg disabled:pointer-events-none disabled:opacity-40"
      >
        {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
        <span className="sr-only">{pinned ? 'Unpin explorer' : 'Pin explorer'}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title="Pin a different worktree"
            className="rounded-sm p-1 text-fg-muted transition-colors hover:bg-elevated hover:text-fg"
          >
            <ChevronDown className="size-3.5" />
            <span className="sr-only">Choose a worktree to pin</span>
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
