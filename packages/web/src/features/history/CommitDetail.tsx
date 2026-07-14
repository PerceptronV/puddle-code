import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { useCommitShow } from '../../lib/worktree-queries';
import { HistoryFileSection } from './HistoryFileSection';
import { bodyBeyondSubject, defaultFileExpanded, formatAbsolute } from './history-logic';

/**
 * The right-hand pane of the history view (SPEC §8, Task 9): one commit's
 * message and its changed files, each a collapsible read-only diff section.
 * `sha^` is a real ref the daemon accepts (`assertSafeRef`'s regex allows
 * `^`) EXCEPT for the root commit, which has no parent — `parents.length ===
 * 0` marks every one of that commit's files as `added` rather than ever
 * fetching `sha^` (see `effectiveStatus`; `HistoryFileContent` still
 * tolerates a `sha^` 404 defensively, but does not rely on it here).
 */
export function CommitDetail({ session, sha }: { session: string; sha: string }) {
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

  const { commit, parents, files } = show.data;
  const isRootCommit = parents.length === 0;
  const body = bodyBeyondSubject(commit.body);
  const expandDefault = defaultFileExpanded(files.length);

  const copySha = () => {
    void navigator.clipboard.writeText(commit.sha);
    toast.success('Commit sha copied');
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-ground">
      <div className="flex flex-col gap-2 px-4 py-3">
        <h2 className="text-sm text-fg">{commit.subject}</h2>
        <button
          type="button"
          onClick={copySha}
          title="Copy full sha"
          className="flex w-fit items-center gap-1.5 font-mono text-xs text-fg-muted transition-colors hover:text-fg"
        >
          <Copy className="size-3" />
          {commit.sha}
        </button>
        <div className="text-xs text-fg-muted">
          {commit.author_name} &lt;{commit.author_email}&gt;
          {' · '}
          <span className="tabular-nums">{formatAbsolute(commit.authored_at)}</span>
        </div>
        {body && <pre className="whitespace-pre-wrap text-xs text-fg-muted">{body}</pre>}
      </div>
      <div className="min-h-0 flex-1">
        {files.length === 0 ? (
          <div className="px-4 py-3 text-xs text-fg-muted">No file changes.</div>
        ) : (
          files.map((entry) => (
            <HistoryFileSection
              key={`${entry.status}:${entry.old_path ?? ''}:${entry.path}`}
              session={session}
              sha={sha}
              entry={entry}
              isRootCommit={isRootCommit}
              defaultExpanded={expandDefault}
            />
          ))
        )}
      </div>
    </div>
  );
}
