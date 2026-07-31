import { useState } from 'react';
import { ChevronRight, CornerLeftUp, FolderClosed, FolderOpen, Undo2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { tildify } from '../../lib/tildify';
import { useHostInfo } from '../../lib/queries';
import { useWorktreeTree } from '../../lib/worktree-queries';
import { FileTypeIcon } from './file-icons';
import { joinPath } from './explorer-paths';

/**
 * The read-only tree the explorer switches to when navigating ABOVE the
 * worktree (SPEC §8): plain browse — expand directories, open files as
 * read-only `external` tabs — with none of the worktree tree's machinery
 * (selection, clipboard, inline edits, DnD, git decorations). That absence is
 * deliberate: every mutation endpoint resolves paths against the WORKTREE
 * root, so offering them here would act on the wrong files. The header walks
 * further up and returns to the worktree.
 */
export function BrowseTree({
  sid,
  root,
  onNavigateUp,
  onReset,
  onOpenFile,
}: {
  sid: string;
  root: string;
  onNavigateUp: () => void;
  onReset: () => void;
  /** Open `path` (relative to `root`) as an external read-only tab. */
  onOpenFile: (path: string, opts?: { preview?: boolean }) => void;
}) {
  const host = useHostInfo();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 px-2">
        <button
          type="button"
          onClick={onNavigateUp}
          disabled={root === '/'}
          title="Parent directory"
          className="shrink-0 rounded-sm p-1 text-fg-gold transition-colors hover:bg-elevated hover:text-fg disabled:pointer-events-none disabled:opacity-40"
        >
          <CornerLeftUp className="size-3.5" />
          <span className="sr-only">Parent directory</span>
        </button>
        <span
          className="min-w-0 truncate font-mono text-xs text-fg-secondary"
          title={`${root} — read-only`}
        >
          {tildify(root, host.data?.home)}
        </span>
        <button
          type="button"
          onClick={onReset}
          title="Back to the worktree"
          className="ml-auto shrink-0 rounded-sm p-1 text-fg-gold transition-colors hover:bg-elevated hover:text-fg"
        >
          <Undo2 className="size-3.5" />
          <span className="sr-only">Back to the worktree</span>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <BrowseDir sid={sid} root={root} dir="" depth={0} onOpenFile={onOpenFile} />
      </div>
    </div>
  );
}

function BrowseDir({
  sid,
  root,
  dir,
  depth,
  onOpenFile,
}: {
  sid: string;
  root: string;
  dir: string;
  depth: number;
  onOpenFile: (path: string, opts?: { preview?: boolean }) => void;
}) {
  const tree = useWorktreeTree(sid, dir, root);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  if (tree.isPending) {
    return (
      <div className="px-3 py-1 text-2xs text-fg-muted" style={{ paddingLeft: depth * 12 + 12 }}>
        …
      </div>
    );
  }
  if (tree.error) {
    return (
      <div className="px-3 py-1 text-2xs text-fg-muted" style={{ paddingLeft: depth * 12 + 12 }}>
        {tree.error instanceof Error ? tree.error.message : 'Unreadable'}
      </div>
    );
  }

  return (
    <>
      {tree.data.entries.map((entry) => {
        const path = joinPath(dir, entry.name);
        const isDir = entry.type === 'dir';
        const open = expanded.has(path);
        return (
          <div key={path}>
            <button
              type="button"
              onClick={() => {
                if (isDir) {
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(path)) next.delete(path);
                    else next.add(path);
                    return next;
                  });
                } else {
                  onOpenFile(path);
                }
              }}
              onDoubleClick={() => {
                if (!isDir) onOpenFile(path, { preview: false });
              }}
              className="flex w-full items-center gap-1.5 py-0.5 pr-2 text-left transition-colors hover:bg-elevated"
              style={{ paddingLeft: depth * 12 + 8 }}
            >
              <ChevronRight
                className={cn(
                  'size-3 shrink-0 text-fg-muted transition-transform',
                  open && 'rotate-90',
                  !isDir && 'invisible',
                )}
              />
              {isDir ? (
                open ? (
                  <FolderOpen className="size-3.5 shrink-0 text-fg" />
                ) : (
                  <FolderClosed className="size-3.5 shrink-0 text-fg" />
                )
              ) : (
                <FileTypeIcon name={entry.name} />
              )}
              <span className="truncate font-mono text-xs text-fg">{entry.name}</span>
              {entry.symlink && <span className="text-2xs text-fg-muted">→</span>}
            </button>
            {isDir && open && (
              <BrowseDir
                sid={sid}
                root={root}
                dir={path}
                depth={depth + 1}
                onOpenFile={onOpenFile}
              />
            )}
          </div>
        );
      })}
      {tree.data.entries.length === 0 && (
        <div className="px-3 py-1 text-2xs text-fg-muted" style={{ paddingLeft: depth * 12 + 12 }}>
          Empty.
        </div>
      )}
    </>
  );
}
