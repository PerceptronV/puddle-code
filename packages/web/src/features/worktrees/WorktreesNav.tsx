import { useMemo, useState } from 'react';
import { GitBranch, Trash2 } from 'lucide-react';
import type { Session, WorktreeInfo } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { usePruneWorktree, useRepoWorktrees } from '../../lib/queries';
import { cn } from '../../lib/utils';

const LIVE = new Set(['starting', 'running', 'waiting_input']);

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/** A small muted status tag (no border/box — HUMANS.md). */
function Tag({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn('shrink-0 text-2xs', className)}>{children}</span>;
}

/**
 * The Worktrees navigator (SPEC §8): every git worktree of the bound repo,
 * grouped by branch, with a prune control. Pruning is blocked (by the daemon,
 * mirrored here) for the repo's own clone, a dirty worktree, or one with a live
 * session; a purely-local branch prompts an extra warning before removal. The
 * branch itself is never deleted — only the working directory.
 */
export function WorktreesNav({
  repoId,
  projectId,
  sessions,
}: {
  repoId: number;
  projectId: string;
  sessions: Session[];
}) {
  const worktrees = useRepoWorktrees(repoId);
  const prune = usePruneWorktree(repoId, projectId);
  const [target, setTarget] = useState<WorktreeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Live sessions per worktree directory — running agents block a prune.
  const liveByPath = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions) {
      if (LIVE.has(s.status)) m.set(s.worktree_path, (m.get(s.worktree_path) ?? 0) + 1);
    }
    return m;
  }, [sessions]);

  // Group by branch; the clone's group leads, then alphabetical.
  const groups = useMemo(() => {
    const byBranch = new Map<string, WorktreeInfo[]>();
    for (const w of worktrees.data?.worktrees ?? []) {
      const key = w.branch ?? '(detached)';
      (byBranch.get(key) ?? byBranch.set(key, []).get(key)!).push(w);
    }
    return [...byBranch.entries()].sort(([, a], [, b]) => {
      const ap = a.some((w) => w.is_primary) ? 0 : 1;
      const bp = b.some((w) => w.is_primary) ? 0 : 1;
      return ap - bp || (a[0]?.branch ?? '').localeCompare(b[0]?.branch ?? '');
    });
  }, [worktrees.data]);

  if (worktrees.isPending) {
    return <div className="px-3 py-2 text-xs text-fg-muted">Loading worktrees…</div>;
  }
  if (worktrees.error) {
    return (
      <div className="px-3 py-2 text-xs text-fg-muted">
        {worktrees.error instanceof Error ? worktrees.error.message : 'Failed to load worktrees'}
      </div>
    );
  }

  const confirmPrune = () => {
    if (!target) return;
    prune.mutate(
      { path: target.path, confirm: true },
      {
        onSuccess: () => setTarget(null),
        onError: (e) => setError(e.message),
      },
    );
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-2">
      {groups.length === 0 && <div className="px-3 py-2 text-xs text-fg-muted">No worktrees.</div>}
      {groups.map(([branch, wts]) => (
        <div key={branch}>
          <div className="flex items-center gap-1.5 px-3 pb-0.5 pt-2 text-2xs text-fg-muted">
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate font-mono">{branch}</span>
          </div>
          {wts.map((wt) => {
            const live = liveByPath.get(wt.path) ?? 0;
            const blockReason = wt.is_primary
              ? 'the repository clone'
              : wt.dirty
                ? 'uncommitted changes'
                : live > 0
                  ? `${live} running session${live > 1 ? 's' : ''}`
                  : null;
            return (
              <div
                key={wt.path}
                className="group flex items-center gap-2 px-3 py-1 pl-6 transition-colors hover:bg-elevated"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={wt.path}>
                  {basename(wt.path)}
                </span>
                {wt.is_primary && <Tag className="text-fg-muted">clone</Tag>}
                {wt.dirty && <Tag className="text-waiting">uncommitted</Tag>}
                {wt.local_only && <Tag className="text-fg-muted">local only</Tag>}
                {live > 0 && <Tag className="text-running">{live} running</Tag>}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      disabled={blockReason !== null}
                      onClick={() => {
                        setError(null);
                        setTarget(wt);
                      }}
                      className="rounded-sm p-1 text-fg-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-0"
                    >
                      <Trash2 className="size-3.5" />
                      <span className="sr-only">Prune worktree</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {blockReason ? `Can't prune — ${blockReason}` : 'Prune worktree'}
                  </TooltipContent>
                </Tooltip>
              </div>
            );
          })}
        </div>
      ))}

      <Dialog
        open={target !== null}
        onOpenChange={(o) => {
          if (!o) setTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Prune worktree</DialogTitle>
            <DialogDescription>
              Remove <span className="font-mono">{target ? basename(target.path) : ''}</span>? The
              working directory is deleted; the branch{' '}
              <span className="font-mono">{target?.branch ?? ''}</span> is kept.
            </DialogDescription>
          </DialogHeader>
          {target?.local_only && (
            <p className="text-xs text-waiting">
              Branch <span className="font-mono">{target.branch}</span> has commits on no remote —
              after pruning they remain only on the local branch, backed up nowhere.
            </p>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={prune.isPending}
              onClick={confirmPrune}
            >
              Prune
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
