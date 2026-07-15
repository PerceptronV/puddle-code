import { useEffect, useRef } from 'react';
import { Button } from '../../components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { cn } from '../../lib/utils';
import { useExplorer } from './explorer-context';
import { basename } from './explorer-paths';
import { DirEntries, fileEntriesOnly } from './TreeNode';

/**
 * File explorer for one worktree (SPEC §8): a VSCode-grade tree with git
 * decorations, rich context menus, a cut/copy/paste clipboard, multi-select and
 * arrow-key navigation, and inline create/rename. State lives in the
 * surrounding `ExplorerProvider` (shared with the header's utility actions in
 * `NavigatorSidebar`); this renders the scroll surface, keyboard host,
 * empty-space menu, and the single delete confirmation.
 */
export function FileExplorer() {
  return (
    <>
      <ExplorerBody />
      <DeleteDialog />
    </>
  );
}

function ExplorerBody() {
  const ex = useExplorer();
  const rootRef = useRef<HTMLDivElement>(null);

  // Keep the keyboard-focused row scrolled into view during arrow navigation.
  useEffect(() => {
    if (!ex.focusedPath || !rootRef.current) return;
    const el = rootRef.current.querySelector(`[data-path="${CSS.escape(ex.focusedPath)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [ex.focusedPath]);

  const canPaste = ex.clipboard !== null;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={rootRef}
          data-explorer-root
          role="tree"
          tabIndex={0}
          onKeyDown={ex.handleKeyDown}
          onPaste={(e) =>
            ex.onUpload('', fileEntriesOnly(e.clipboardData.items, e.clipboardData.files))
          }
          onDragOver={(e) => {
            e.preventDefault();
            ex.setDropTarget('');
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) ex.setDropTarget(null);
          }}
          onDrop={(e) => {
            e.preventDefault();
            ex.setDropTarget(null);
            const dragged = e.dataTransfer.getData('application/x-puddle-path');
            if (dragged) ex.onInternalDrop('', dragged);
            else ex.onUpload('', fileEntriesOnly(e.dataTransfer.items, e.dataTransfer.files));
          }}
          className={cn(
            'h-full overflow-y-auto py-1 outline-none',
            ex.dropTarget === '' && 'bg-selection',
          )}
        >
          <DirEntries sid={ex.sid} path="" depth={0} />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => ex.beginCreate('', 'file')}>New File…</ContextMenuItem>
        <ContextMenuItem onSelect={() => ex.beginCreate('', 'dir')}>New Folder…</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!canPaste} onSelect={() => ex.paste('')}>
          Paste
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => ex.copyPathToClipboard('', false)}>
          Copy Path
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => ex.download('')}>Download worktree</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The single, provider-owned delete confirmation (deletion is irreversible — no host trash). */
function DeleteDialog() {
  const ex = useExplorer();
  const paths = ex.pendingDelete;
  const open = paths !== null;
  const label =
    paths && paths.length === 1 ? `“${basename(paths[0]!)}”` : `${paths?.length ?? 0} items`;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && ex.cancelDelete()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {label}?</DialogTitle>
          <DialogDescription>
            This permanently removes {paths && paths.length > 1 ? 'them' : 'it'} from the worktree.
            There is no undo.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={ex.cancelDelete}>
            Cancel
          </Button>
          <Button variant="danger" onClick={ex.confirmDelete}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
