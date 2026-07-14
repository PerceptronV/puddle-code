import { createContext, useContext } from 'react';
import { ChevronRight, File, FolderClosed, FolderOpen, Link2 } from 'lucide-react';
import { toast } from 'sonner';
import type { TreeEntry } from '@puddle/shared';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '../../components/ui/context-menu';
import { cn } from '../../lib/utils';
import { downloadPath, useWorktreeTree } from '../../lib/worktree-queries';

const INDENT_PX = 14;

/** State/callbacks shared by every row, provided once by `FileExplorer` (avoids prop-drilling through recursion). */
export interface ExplorerCtx {
  sid: string;
  expanded: Set<string>;
  toggle(path: string): void;
  onOpenFile?: (sid: string, path: string) => void;
  onUpload(dir: string, files: File[]): void;
  dropTarget: string | null;
  setDropTarget(path: string | null): void;
}

export const ExplorerContext = createContext<ExplorerCtx | null>(null);

function useExplorerCtx(): ExplorerCtx {
  const ctx = useContext(ExplorerContext);
  if (!ctx) throw new Error('TreeNode/DirEntries rendered outside <FileExplorer>');
  return ctx;
}

/** Rejects any dropped/pasted directory entries with a toast; returns only the plain files. */
export function fileEntriesOnly(items: DataTransferItemList | undefined, files: FileList): File[] {
  const entries = Array.from(items ?? []).map((item) => item.webkitGetAsEntry?.() ?? null);
  if (entries.some((entry) => entry?.isDirectory)) {
    toast.error("Folders can't be uploaded yet — zip them first");
  }
  return Array.from(files).filter((_, i) => entries[i]?.isDirectory !== true);
}

/** One explorer row; a directory recurses into `DirEntries` for its children when expanded (SPEC §8). */
export function TreeNode({
  path,
  entry,
  depth,
}: {
  path: string;
  entry: TreeEntry;
  depth: number;
}) {
  const { sid, expanded, toggle, onOpenFile, onUpload, dropTarget, setDropTarget } =
    useExplorerCtx();
  const isDir = entry.type === 'dir';
  const isOpen = isDir && expanded.has(path);
  const isDropTarget = isDir && dropTarget === path;

  const activate = () => (isDir ? toggle(path) : onOpenFile?.(sid, path));

  const row = (
    <div
      role="treeitem"
      aria-expanded={isDir ? isOpen : undefined}
      tabIndex={0}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        activate();
      }}
      onDragOver={(e) => {
        if (!isDir) return;
        e.preventDefault();
        e.stopPropagation();
        setDropTarget(path);
      }}
      onDragLeave={(e) => {
        if (isDir && e.currentTarget === e.target) setDropTarget(null);
      }}
      onDrop={(e) => {
        if (!isDir) return;
        e.preventDefault();
        e.stopPropagation();
        setDropTarget(null);
        onUpload(path, fileEntriesOnly(e.dataTransfer.items, e.dataTransfer.files));
      }}
      style={{ paddingLeft: depth * INDENT_PX + 8 }}
      className={cn(
        'flex h-6 cursor-pointer items-center gap-1 pr-2 text-sm transition-colors hover:bg-elevated',
        isDropTarget && 'bg-selection',
      )}
    >
      {isDir ? (
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-fg-muted transition-transform duration-150',
            isOpen && 'rotate-90',
          )}
        />
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      {isDir ? (
        isOpen ? (
          <FolderOpen className="size-3.5 shrink-0 text-fg-muted" />
        ) : (
          <FolderClosed className="size-3.5 shrink-0 text-fg-muted" />
        )
      ) : entry.type === 'symlink' ? (
        <Link2 className="size-3.5 shrink-0 text-fg-muted" />
      ) : (
        <File className="size-3.5 shrink-0 text-fg-muted" />
      )}
      <span
        className={cn(
          'truncate font-mono',
          entry.name.startsWith('.') ? 'text-fg-muted' : 'text-fg',
        )}
      >
        {entry.name}
      </span>
    </div>
  );

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onSelect={() =>
              void downloadPath(sid, path).catch((e: unknown) =>
                toast.error(e instanceof Error ? e.message : 'Download failed'),
              )
            }
          >
            Download
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              void navigator.clipboard.writeText(path);
              toast.success('Path copied');
            }}
          >
            Copy path
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {isDir && isOpen && <DirEntries sid={sid} path={path} depth={depth + 1} />}
    </>
  );
}

/** A directory's children: mounts its own `useWorktreeTree` and renders a `TreeNode` per entry. */
export function DirEntries({ sid, path, depth }: { sid: string; path: string; depth: number }) {
  const tree = useWorktreeTree(sid, path);
  const pad = { paddingLeft: depth * INDENT_PX + 8 };

  if (tree.isLoading) {
    return (
      <div style={pad} className="py-0.5 text-xs text-fg-muted">
        Loading…
      </div>
    );
  }
  if (tree.isError) {
    return (
      <div style={pad} className="py-0.5 text-xs text-fg-muted">
        {tree.error instanceof Error ? tree.error.message : "Couldn't load this folder."}
      </div>
    );
  }
  const entries = tree.data?.entries ?? [];
  if (entries.length === 0) {
    return (
      <div style={pad} className="py-0.5 text-xs text-fg-muted">
        Empty
      </div>
    );
  }
  return (
    <>
      {entries.map((entry) => (
        <TreeNode
          key={entry.name}
          path={path ? `${path}/${entry.name}` : entry.name}
          entry={entry}
          depth={depth}
        />
      ))}
    </>
  );
}
