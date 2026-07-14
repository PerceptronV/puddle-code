import { useCommitShow } from '../../lib/worktree-queries';
import { HistoryFileContent } from './HistoryFileContent';

/**
 * One file's commit diff (`sha^`→`sha`), hosted as a centre-editor tab (SPEC
 * §8): the navigator's History list opens these. Read-only start to finish —
 * `HistoryFileContent` uses wholly private models, never the shared buffer —
 * so a commit tab never carries dirty state. The entry is re-derived from the
 * commit's `show` by path; the root-commit flag comes from its parents.
 */
export function CommitTabBody({
  session,
  sha,
  path,
}: {
  session: string;
  sha: string;
  path: string;
}) {
  const show = useCommitShow(session, sha);

  if (show.isPending) {
    return <div className="px-4 py-3 text-xs text-fg-muted">Loading commit…</div>;
  }
  if (show.error) {
    return (
      <div className="px-4 py-3 text-xs text-fg-muted">
        {show.error instanceof Error ? show.error.message : 'Failed to load commit'}
      </div>
    );
  }

  const entry = show.data.files.find((e) => e.path === path);
  if (!entry) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-fg-muted">
        <span className="font-mono">{path}</span> is not part of {sha.slice(0, 7)}.
      </div>
    );
  }

  return (
    <div className="h-full">
      <HistoryFileContent
        session={session}
        sha={sha}
        entry={entry}
        isRootCommit={show.data.parents.length === 0}
      />
    </div>
  );
}
