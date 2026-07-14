// Load-bearing: import the Monaco bootstrap BEFORE anything that mounts an
// <Editor>/<DiffEditor> (same contract as LazyDiffView.tsx / EditorZone.tsx).
// `monaco-setup` runs `loader.config({ monaco })`, pointing @monaco-editor/react
// at the bundled Monaco instead of a CDN. Keeping this the very first import of
// the lazy history chunk's entry module guarantees it evaluates first. Do not
// reorder.
import '../editor/monaco-setup';

import { useEffect, useState } from 'react';
import { useWorktreeLog } from '../../lib/worktree-queries';
import { CommitDetail } from './CommitDetail';
import { CommitList } from './CommitList';

/** Fixed-ish width for the commit list column; the detail pane takes the rest. */
const LIST_WIDTH = 320;

/**
 * The History view of a session's worktree (SPEC §8, Task 9): a commit list
 * on the left, the selected commit's message and per-file read-only diffs on
 * the right. Every diff here is `sha`→`sha^`, never the working tree, so
 * nothing in this feature ever touches the shared editor buffer store —
 * unlike the Diff view, history is read-only start to finish.
 *
 * Calls `useWorktreeLog` itself (same query key `CommitList` also reads) only
 * to gate the top-level loading/error/empty states and to pick the default
 * selection — React Query dedupes the request, so this is not a second
 * fetch, just a second read of the one cached page set.
 *
 * Behind the lazy boundary (see LazyHistoryView) and applies to the ACTIVE
 * session only — Workspace passes the active session id.
 */
export function HistoryView({ session }: { session: string }) {
  const log = useWorktreeLog(session);
  const commits = log.data?.pages.flatMap((p) => p.commits) ?? [];
  const [selected, setSelected] = useState<string | null>(null);

  // Default selection: the newest commit, once the first page has loaded and
  // nothing has been picked yet. `git log` (and `logPage`) list newest-first,
  // so `commits[0]` is HEAD's own commit — the obvious thing to show first,
  // mirroring "open on the most recent change". Never re-fires once a
  // selection exists (including a user's own pick of an older commit).
  useEffect(() => {
    if (selected === null && commits.length > 0) {
      const newest = commits[0];
      if (newest) setSelected(newest.sha);
    }
  }, [selected, commits]);

  if (log.isPending) {
    return <div className="px-4 py-3 text-xs text-fg-muted">Loading history…</div>;
  }
  if (log.error) {
    return (
      <div className="px-4 py-3 text-xs text-fg-muted">
        {log.error instanceof Error ? log.error.message : 'Failed to load history'}
      </div>
    );
  }
  if (commits.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-fg-muted">
        No commits yet.
      </div>
    );
  }

  return (
    <div className="flex h-full bg-ground">
      <div style={{ width: LIST_WIDTH }} className="h-full shrink-0 overflow-y-auto bg-surface">
        <CommitList session={session} selected={selected} onSelect={setSelected} />
      </div>
      <div className="min-w-0 flex-1">
        {selected ? (
          <CommitDetail session={session} sha={selected} />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-fg-muted">…</div>
        )}
      </div>
    </div>
  );
}
