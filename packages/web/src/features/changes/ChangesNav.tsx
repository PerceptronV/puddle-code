import { CommitGraph } from './CommitGraph';
import { UncommittedPanel } from './UncommittedPanel';

/**
 * The unified Changes navigator (SPEC §8): the worktree's uncommitted changes
 * on top and its commit-dependency graph below, replacing the separate Diff and
 * History navigators. The top panel lists working-tree changes (staged +
 * unstaged) as a tree or flat list; the bottom panel is the interactive commit
 * graph. Both open their content as centre-editor tabs, keeping the editor the
 * single content surface.
 */
export function ChangesNav({
  session,
  root,
  activeDiffPath,
  onOpenDiff,
  onOpenCommitFile,
}: {
  session: string;
  /**
   * `?root=` for a directory target — the project's own repository, when no
   * session is bound (protocol 12.4). Undefined for a session's worktree.
   */
  root?: string;
  /** Path of the active editor tab when it is an uncommitted diff for `session`. */
  activeDiffPath: string | null;
  onOpenDiff: (path: string, opts?: { preview?: boolean }) => void;
  onOpenCommitFile: (path: string, sha: string, opts?: { preview?: boolean }) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <section className="flex max-h-[45%] min-h-0 flex-col">
        <UncommittedPanel
          session={session}
          root={root}
          activePath={activeDiffPath}
          onOpen={onOpenDiff}
        />
      </section>
      <div className="h-px shrink-0 bg-border" />
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-7 shrink-0 items-center px-3">
          <span className="text-2xs font-medium uppercase tracking-wide text-fg-gold">History</span>
        </div>
        <CommitGraph session={session} root={root} onOpenCommitFile={onOpenCommitFile} />
      </div>
    </div>
  );
}
