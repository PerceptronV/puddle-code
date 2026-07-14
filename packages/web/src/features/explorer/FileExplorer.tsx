import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Session } from '@puddle/shared';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '../../components/ui/context-menu';
import { cn } from '../../lib/utils';
import { downloadPath, uploadFiles } from '../../lib/worktree-queries';
import { DirEntries, ExplorerContext, fileEntriesOnly, type ExplorerCtx } from './TreeNode';

/**
 * File explorer for one worktree (SPEC §8): the root tree via
 * `useWorktreeTree(session.id, '')` (through `DirEntries`), with each
 * expanded directory mounting its own subtree. `onOpenFile` is a no-op when
 * omitted — Task 3.6b wires the real editor.
 */
export function FileExplorer({
  session,
  onOpenFile,
}: {
  session: Session;
  onOpenFile?: (sid: string, path: string) => void;
}) {
  const sid = session.id;
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const onUpload = useCallback(
    (dir: string, files: File[]) => {
      if (files.length === 0) return;
      uploadFiles(sid, dir, files)
        .then(() => {
          void qc.invalidateQueries({ queryKey: ['wt-tree', sid, dir] });
          toast.success(
            files.length === 1 ? `Uploaded ${files[0]!.name}` : `Uploaded ${files.length} files`,
          );
        })
        .catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Upload failed'));
    },
    [sid, qc],
  );

  const ctx: ExplorerCtx = {
    sid,
    expanded,
    toggle,
    onOpenFile,
    onUpload,
    dropTarget,
    setDropTarget,
  };

  return (
    <ExplorerContext.Provider value={ctx}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            tabIndex={-1}
            onPaste={(e) =>
              onUpload('', fileEntriesOnly(e.clipboardData.items, e.clipboardData.files))
            }
            onDragOver={(e) => {
              e.preventDefault();
              setDropTarget('');
            }}
            onDragLeave={(e) => {
              if (e.currentTarget === e.target) setDropTarget(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDropTarget(null);
              onUpload('', fileEntriesOnly(e.dataTransfer.items, e.dataTransfer.files));
            }}
            className={cn('h-full overflow-y-auto py-1', dropTarget === '' && 'bg-selection')}
          >
            <DirEntries sid={sid} path="" depth={0} />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onSelect={() =>
              void downloadPath(sid, '').catch((e: unknown) =>
                toast.error(e instanceof Error ? e.message : 'Download failed'),
              )
            }
          >
            Download worktree
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              void navigator.clipboard.writeText(session.worktree_path);
              toast.success('Path copied');
            }}
          >
            Copy path
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </ExplorerContext.Provider>
  );
}
