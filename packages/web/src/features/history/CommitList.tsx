import { useMemo } from 'react';
import { cn } from '../../lib/utils';
import { useWorktreeLog } from '../../lib/worktree-queries';
import { relativeTime } from './history-logic';

const SHA_LEN = 7;

/**
 * The left-hand pane of the history view (SPEC §8, Task 9): the commit list,
 * newest first (the daemon's `log` is a plain `git log`, no `--reverse`),
 * paginated 50 at a time via `useWorktreeLog`'s `useInfiniteQuery`. Calls the
 * same query `HistoryView` already calls for its own loading/empty gating and
 * default selection — same cache key, so this is a read of already-fetched
 * data, not a second request.
 */
export function CommitList({
  session,
  selected,
  onSelect,
}: {
  session: string;
  selected: string | null;
  onSelect: (sha: string) => void;
}) {
  const log = useWorktreeLog(session);
  const commits = useMemo(() => log.data?.pages.flatMap((p) => p.commits) ?? [], [log.data]);

  if (log.isPending) {
    return <div className="px-3 py-2 text-xs text-fg-muted">Loading…</div>;
  }
  if (log.error) {
    return (
      <div className="px-3 py-2 text-xs text-fg-muted">
        {log.error instanceof Error ? log.error.message : 'Failed to load history'}
      </div>
    );
  }
  if (commits.length === 0) {
    return <div className="px-3 py-2 text-xs text-fg-muted">No commits yet.</div>;
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {commits.map((commit) => (
        <button
          key={commit.sha}
          type="button"
          onClick={() => onSelect(commit.sha)}
          className={cn(
            'flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-elevated',
            selected === commit.sha && 'bg-selection',
          )}
        >
          <div className="flex items-baseline gap-2">
            <span className="shrink-0 font-mono text-xs text-fg-muted">
              {commit.sha.slice(0, SHA_LEN)}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-fg">{commit.subject}</span>
          </div>
          <div className="truncate text-2xs text-fg-muted">
            {commit.author_name} ·{' '}
            <span className="tabular-nums">{relativeTime(commit.authored_at)}</span>
          </div>
        </button>
      ))}
      {log.hasNextPage && (
        <button
          type="button"
          onClick={() => void log.fetchNextPage()}
          disabled={log.isFetchingNextPage}
          className="px-3 py-2 text-left font-mono text-xs text-fg-muted transition-colors hover:bg-elevated"
        >
          {log.isFetchingNextPage ? 'Loading…' : 'Show more'}
        </button>
      )}
    </div>
  );
}
