// Load-bearing: import the Monaco bootstrap BEFORE anything that mounts an
// <Editor>/<DiffEditor> (same contract as EditorZone.tsx). `monaco-setup` runs
// `loader.config({ monaco })`, pointing @monaco-editor/react at the bundled
// Monaco instead of a CDN. Keeping this the very first import of the lazy diff
// chunk's entry module guarantees it evaluates first. Do not reorder.
import '../editor/monaco-setup';

import { useWorktreeDiff } from '../../lib/worktree-queries';
import { summariseCounts, defaultExpanded } from './diff-status';
import { FileDiffSection } from './FileDiffSection';

/**
 * The Diff view of a session's worktree (SPEC §8): its working tree against the
 * merge-base (or an explicit commit), one collapsible `FileDiffSection` per
 * changed file in a single scroll container. The modified side of each diff IS
 * the editor tab's shared buffer, so edits here save through the very same
 * path — no separate save flow. There is no refresh button: `useWorktreeDiff`
 * polls every 10 s and refetches on window focus.
 *
 * Behind the lazy boundary (see LazyDiffView) and applies to the ACTIVE
 * session only — Workspace passes the active session id.
 */
export function DiffView({ session }: { session: string }) {
  const diff = useWorktreeDiff(session);

  if (diff.isPending) {
    return <div className="px-4 py-3 text-xs text-fg-muted">Loading diff…</div>;
  }
  if (diff.error) {
    return (
      <div className="px-4 py-3 text-xs text-fg-muted">
        {diff.error instanceof Error ? diff.error.message : 'Failed to load diff'}
      </div>
    );
  }

  const { against, base_ref, entries } = diff.data;
  const shortAgainst = against.slice(0, 7);
  const baseLabel = base_ref ?? shortAgainst;

  return (
    <div className="flex h-full flex-col bg-ground">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-4 py-2 font-mono text-xs text-fg-secondary">
        {base_ref && <span>{base_ref}</span>}
        <span className="text-fg-muted">{shortAgainst}</span>
        {entries.length > 0 && <span className="text-fg-muted">{summariseCounts(entries)}</span>}
      </div>
      {entries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">
          No changes against {baseLabel}.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {entries.map((entry, index) => (
            <FileDiffSection
              key={`${entry.status}:${entry.old_path ?? ''}:${entry.path}`}
              session={session}
              against={against}
              entry={entry}
              defaultExpanded={defaultExpanded(index)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
