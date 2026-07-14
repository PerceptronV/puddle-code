import { useWorktreeDiff } from '../../lib/worktree-queries';
import { cn } from '../../lib/utils';
import { diffStatusStyle, summariseCounts } from './diff-status';

/**
 * The Diff navigator in the left sidebar (SPEC §8): the changed files of one
 * worktree against its base, newest listing on every 10 s poll. It is a
 * list, not the diff itself — clicking a file opens that file's diff as a
 * centre-editor tab (`onOpen`), keeping the sidebar a navigator and the editor
 * the single content surface. Highlights the file whose diff tab is active.
 */
export function DiffNav({
  session,
  activePath,
  onOpen,
}: {
  session: string;
  activePath: string | null;
  onOpen: (path: string) => void;
}) {
  const diff = useWorktreeDiff(session);

  if (diff.isPending) {
    return <div className="px-3 py-2 text-xs text-fg-muted">Loading diff…</div>;
  }
  if (diff.error) {
    return (
      <div className="px-3 py-2 text-xs text-fg-muted">
        {diff.error instanceof Error ? diff.error.message : 'Failed to load diff'}
      </div>
    );
  }

  const { against, base_ref, entries } = diff.data;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1.5 font-mono text-2xs text-fg-muted">
        <span>{base_ref ?? against.slice(0, 7)}</span>
        {entries.length > 0 && <span>{summariseCounts(entries)}</span>}
      </div>
      {entries.length === 0 ? (
        <div className="px-3 py-2 text-xs text-fg-muted">No changes against the base.</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {entries.map((entry) => {
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
                onClick={() => onOpen(entry.path)}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1 text-left transition-colors hover:bg-elevated',
                  activePath === entry.path && 'bg-selection',
                )}
              >
                <span className={cn('w-3 shrink-0 font-mono text-xs', style.colourClass)}>
                  {style.letter}
                </span>
                <span className="truncate font-mono text-xs text-fg">{label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
