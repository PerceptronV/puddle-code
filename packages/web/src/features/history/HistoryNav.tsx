import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useCommitShow, useWorktreeLog } from '../../lib/worktree-queries';
import { cn } from '../../lib/utils';
import { diffStatusStyle } from '../diff/diff-status';
import { relativeTime } from './history-logic';

const SHA_LEN = 7;

/** The changed files of one expanded commit; each opens a commit diff tab. */
function CommitFiles({
  session,
  sha,
  onOpen,
}: {
  session: string;
  sha: string;
  onOpen: (path: string, sha: string) => void;
}) {
  const show = useCommitShow(session, sha);

  if (show.isPending) return <div className="px-3 py-1 pl-8 text-2xs text-fg-muted">…</div>;
  if (show.error) {
    return (
      <div className="px-3 py-1 pl-8 text-2xs text-fg-muted">
        {show.error instanceof Error ? show.error.message : 'Failed to load commit'}
      </div>
    );
  }
  if (show.data.files.length === 0) {
    return <div className="px-3 py-1 pl-8 text-2xs text-fg-muted">No file changes.</div>;
  }

  return (
    <>
      {show.data.files.map((entry) => {
        const style = diffStatusStyle(entry.status);
        const label =
          entry.status === 'renamed' && entry.old_path
            ? `${entry.old_path} → ${entry.path}`
            : entry.path;
        return (
          <button
            key={`${entry.status}:${entry.old_path ?? ''}:${entry.path}`}
            type="button"
            title={label}
            onClick={() => onOpen(entry.path, sha)}
            className="flex w-full items-center gap-2 py-1 pl-8 pr-3 text-left transition-colors hover:bg-elevated"
          >
            <span className={cn('w-3 shrink-0 font-mono text-xs', style.colourClass)}>
              {style.letter}
            </span>
            <span className="truncate font-mono text-2xs text-fg">{label}</span>
          </button>
        );
      })}
    </>
  );
}

/**
 * The History navigator in the left sidebar (SPEC §8): the worktree's commits,
 * newest first, paginated. Clicking a commit expands its changed files inline;
 * clicking a file opens its `sha^`→`sha` diff as a read-only centre-editor tab
 * (`onOpen`). Like the Diff navigator, the sidebar stays a list and the editor
 * hosts the content.
 */
export function HistoryNav({
  session,
  onOpen,
}: {
  session: string;
  onOpen: (path: string, sha: string) => void;
}) {
  const log = useWorktreeLog(session);
  const [openSha, setOpenSha] = useState<string | null>(null);

  if (log.isPending) {
    return <div className="px-3 py-2 text-xs text-fg-muted">Loading history…</div>;
  }
  if (log.error) {
    return (
      <div className="px-3 py-2 text-xs text-fg-muted">
        {log.error instanceof Error ? log.error.message : 'Failed to load history'}
      </div>
    );
  }

  const commits = log.data.pages.flatMap((p) => p.commits);
  if (commits.length === 0) {
    return <div className="px-3 py-2 text-xs text-fg-muted">No commits yet.</div>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-2">
      {commits.map((commit) => {
        const open = openSha === commit.sha;
        return (
          <div key={commit.sha}>
            <button
              type="button"
              onClick={() => setOpenSha(open ? null : commit.sha)}
              className={cn(
                'flex w-full items-start gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-elevated',
                open && 'bg-selection',
              )}
            >
              {open ? (
                <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-fg-muted" />
              ) : (
                <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-fg-muted" />
              )}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-baseline gap-2">
                  <span className="shrink-0 font-mono text-2xs text-fg-muted">
                    {commit.sha.slice(0, SHA_LEN)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-fg">{commit.subject}</span>
                </span>
                <span className="truncate text-2xs text-fg-muted">
                  {commit.author_name} ·{' '}
                  <span className="tabular-nums">{relativeTime(commit.authored_at)}</span>
                </span>
              </span>
            </button>
            {open && <CommitFiles session={session} sha={commit.sha} onOpen={onOpen} />}
          </div>
        );
      })}
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
