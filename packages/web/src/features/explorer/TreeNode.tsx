import { useEffect, useRef, useState } from 'react';
import { ChevronRight, FolderClosed, FolderOpen, Link2 } from 'lucide-react';
import { toast } from 'sonner';
import type { TreeEntry } from '@puddle/shared';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../components/ui/context-menu';
import { cn } from '../../lib/utils';
import { useWorktreeTree } from '../../lib/worktree-queries';
import { encodeTabTransfer, TAB_MIME } from '../workspace/tab-transfer';
import { useExplorer } from './explorer-context';
import { dirOf, joinPath, type VisibleRow } from './explorer-paths';
import { FileTypeIcon } from './file-icons';
import { folderStatus, gitDecoration } from './git-decoration';

const INDENT_PX = 14;
const PUDDLE_PATH_MIME = 'application/x-puddle-path';

/** Rejects any dropped/pasted directory entries with a toast; returns only the plain files. */
export function fileEntriesOnly(items: DataTransferItemList | undefined, files: FileList): File[] {
  const entries = Array.from(items ?? []).map((item) => item.webkitGetAsEntry?.() ?? null);
  if (entries.some((entry) => entry?.isDirectory)) {
    toast.error("Folders can't be uploaded yet — zip them first");
  }
  return Array.from(files).filter((_, i) => entries[i]?.isDirectory !== true);
}

/** A short right-aligned keyboard-shortcut hint inside a menu row. */
function Shortcut({ children }: { children: React.ReactNode }) {
  return <span className="ml-auto pl-6 text-2xs text-fg-muted tabular-nums">{children}</span>;
}

/** The inline text input used for both rename and new-entry creation (VSCode-style, no dialog). */
function EditRow({
  depth,
  initial,
  icon,
  onCommit,
  onCancel,
}: {
  depth: number;
  initial: string;
  icon: React.ReactNode;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Select the basename, not the extension (matches VSCode rename).
    const dot = initial.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    onCommit(ref.current?.value ?? '');
  };
  return (
    <div
      className="flex h-6 items-center gap-1 pr-2"
      style={{ paddingLeft: depth * INDENT_PX + 8 }}
    >
      <span className="size-3.5 shrink-0" />
      {icon}
      <input
        ref={ref}
        defaultValue={initial}
        spellCheck={false}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') {
            done.current = true;
            onCancel();
          }
        }}
        onBlur={commit}
        className="min-w-0 flex-1 bg-surface font-mono text-sm text-fg outline-none"
      />
    </div>
  );
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
  const ex = useExplorer();
  const isDir = entry.type === 'dir';
  const isOpen = isDir && ex.expanded.has(path);
  const isDropTarget = isDir && ex.dropTarget === path;
  const isActive = !isDir && path === ex.activePath;
  const isSelected = ex.selection.has(path);
  const isCut = ex.clipboard?.mode === 'cut' && ex.clipboard.paths.includes(path);
  const row: VisibleRow = {
    path,
    name: entry.name,
    type: entry.type,
    depth,
    parentDir: dirOf(path),
  };

  const status = ex.statusMap.get(path);
  const folderTint = isDir ? folderStatus(ex.statusMap, path) : null;
  const decoration = status ? gitDecoration(status) : folderTint ? gitDecoration(folderTint) : null;
  const nameColour = decoration
    ? decoration.colourClass
    : entry.name.startsWith('.')
      ? 'text-fg-muted'
      : 'text-fg';

  // The paste target and the entries a menu action operates on (respect a
  // multi-selection that includes this row; otherwise just this row).
  const targets = isSelected && ex.selection.size > 1 ? [...ex.selection] : [path];
  const pasteDir = isDir ? path : dirOf(path);
  const canPaste = ex.clipboard !== null;

  const editingHere = ex.editing?.mode === 'rename' && ex.editing.path === path;

  if (editingHere) {
    return (
      <EditRow
        depth={depth}
        initial={entry.name}
        icon={
          isDir ? (
            <FolderClosed className="size-3.5 shrink-0 text-fg" />
          ) : (
            <FileTypeIcon name={entry.name} />
          )
        }
        onCommit={ex.commitEdit}
        onCancel={ex.cancelEdit}
      />
    );
  }

  const rowEl = (
    <div
      role="treeitem"
      data-path={path}
      aria-expanded={isDir ? isOpen : undefined}
      aria-selected={isSelected}
      tabIndex={-1}
      draggable
      onClick={(e) => {
        (e.currentTarget.closest('[data-explorer-root]') as HTMLElement | null)?.focus();
        ex.onRowClick(row, e);
      }}
      onDoubleClick={() => ex.onRowDoubleClick(row)}
      onContextMenu={() => {
        // Right-clicking a row outside the selection selects just it first
        // (without toggling/opening it, unlike a plain click).
        if (!isSelected) ex.selectOnly(path);
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData(PUDDLE_PATH_MIME, path);
        // A file row is also draggable into the centre tiling area, where the
        // drop opens it as a permanent, positioned editor tab (SPEC §8).
        if (!isDir) {
          e.dataTransfer.setData(
            TAB_MIME,
            encodeTabTransfer({ type: 'editor', tab: { kind: 'file', session: ex.sid, path } }),
          );
        }
        e.dataTransfer.effectAllowed = 'copyMove';
      }}
      onDragOver={(e) => {
        if (!isDir) return;
        e.preventDefault();
        e.stopPropagation();
        ex.setDropTarget(path);
      }}
      onDragLeave={(e) => {
        if (isDir && e.currentTarget === e.target) ex.setDropTarget(null);
      }}
      onDrop={(e) => {
        if (!isDir) return;
        e.preventDefault();
        e.stopPropagation();
        ex.setDropTarget(null);
        const dragged = e.dataTransfer.getData(PUDDLE_PATH_MIME);
        if (dragged) ex.onInternalDrop(path, dragged);
        else ex.onUpload(path, fileEntriesOnly(e.dataTransfer.items, e.dataTransfer.files));
      }}
      style={{ paddingLeft: depth * INDENT_PX + 8 }}
      className={cn(
        'flex h-6 cursor-pointer items-center gap-1 pr-2 text-sm transition-colors hover:bg-elevated',
        isSelected ? 'bg-selection' : isActive && 'bg-elevated',
        isDropTarget && 'bg-selection',
        isCut && 'opacity-50',
      )}
    >
      {isDir ? (
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-fg-gold transition-transform duration-150',
            isOpen && 'rotate-90',
          )}
        />
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      {/* Untinted icons wear the heading colour (text-fg), never gold — colour
          on a tree icon means git status (a gold default read as "modified"). */}
      {isDir ? (
        isOpen ? (
          <FolderOpen
            className={cn('size-3.5 shrink-0', folderTint ? decoration?.colourClass : 'text-fg')}
          />
        ) : (
          <FolderClosed
            className={cn('size-3.5 shrink-0', folderTint ? decoration?.colourClass : 'text-fg')}
          />
        )
      ) : entry.type === 'symlink' ? (
        <Link2 className="size-3.5 shrink-0 text-fg" />
      ) : (
        <FileTypeIcon name={entry.name} dimmed={status === 'ignored'} />
      )}
      <span className={cn('min-w-0 flex-1 truncate font-mono', nameColour)}>{entry.name}</span>
      {status && decoration && decoration.letter && (
        <span className={cn('shrink-0 font-mono text-2xs', decoration.colourClass)}>
          {decoration.letter}
        </span>
      )}
    </div>
  );

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{rowEl}</ContextMenuTrigger>
        <ContextMenuContent>
          {isDir && (
            <>
              <ContextMenuItem onSelect={() => ex.beginCreate(path, 'file')}>
                New File…
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => ex.beginCreate(path, 'dir')}>
                New Folder…
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onSelect={() => ex.cut(targets)}>
            Cut <Shortcut>⌘X</Shortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => ex.copy(targets)}>
            Copy <Shortcut>⌘C</Shortcut>
          </ContextMenuItem>
          <ContextMenuItem disabled={!canPaste} onSelect={() => ex.paste(pasteDir)}>
            Paste <Shortcut>⌘V</Shortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => ex.copyPathToClipboard(path, false)}>
            Copy Path <Shortcut>⌥⌘C</Shortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => ex.copyPathToClipboard(path, true)}>
            Copy Relative Path <Shortcut>⌥⇧⌘C</Shortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => ex.beginRename(path)}>
            Rename… <Shortcut>F2</Shortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => ex.requestDelete(targets)}>
            Delete <Shortcut>⌘⌫</Shortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => ex.download(path)}>Download</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {isDir && isOpen && <DirEntries sid={ex.sid} path={path} depth={depth + 1} />}
    </>
  );
}

/** A directory's children: mounts its own `useWorktreeTree` and renders a `TreeNode` per entry. */
export function DirEntries({ sid, path, depth }: { sid: string; path: string; depth: number }) {
  const ex = useExplorer();
  const tree = useWorktreeTree(sid, path);
  const pad = { paddingLeft: depth * INDENT_PX + 8 };

  const editing = ex.editing;
  const createRow =
    editing?.mode === 'create' && editing.parentDir === path ? (
      <CreateRow depth={depth} kind={editing.kind} />
    ) : null;

  if (tree.isLoading) {
    return (
      <>
        {createRow}
        <div style={pad} className="py-0.5 text-xs text-fg-muted">
          Loading…
        </div>
      </>
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
  if (entries.length === 0 && !createRow) {
    return (
      <div style={pad} className="py-0.5 text-xs text-fg-muted">
        Empty
      </div>
    );
  }
  return (
    <>
      {createRow}
      {entries.map((entry) => (
        <TreeNode key={entry.name} path={joinPath(path, entry.name)} entry={entry} depth={depth} />
      ))}
    </>
  );
}

/** The pending new-file/new-folder input row under its parent directory. */
function CreateRow({ depth, kind }: { depth: number; kind: 'file' | 'dir' }) {
  const ex = useExplorer();
  const [name, setName] = useState('');
  return (
    <EditRow
      depth={depth}
      initial={name}
      icon={
        kind === 'dir' ? (
          <FolderClosed className="size-3.5 shrink-0 text-fg" />
        ) : (
          <FileTypeIcon name={name || 'file'} />
        )
      }
      onCommit={(value) => {
        setName(value);
        ex.commitEdit(value);
      }}
      onCancel={ex.cancelEdit}
    />
  );
}
