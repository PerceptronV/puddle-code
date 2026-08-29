import { ContextMenuItem, ContextMenuSeparator } from '../../components/ui/context-menu';

/** A short right-aligned keyboard-shortcut hint inside a file menu row. */
export function Shortcut({ children }: { children: React.ReactNode }) {
  return <span className="ml-auto pl-6 text-2xs text-fg-muted tabular-nums">{children}</span>;
}

/**
 * The actions shared by file-tree rows and path-backed editor tabs. Keeping the
 * rows here makes the two context menus one surface rather than two copies that
 * gradually acquire different labels, ordering, or shortcut hints.
 */
export function FileMenuItems({
  readOnly,
  canPaste,
  onCut,
  onCopy,
  onPaste,
  onCopyPath,
  onCopyRelativePath,
  onReveal,
  onCompilationSettings,
  onRename,
  onDelete,
  onDownload,
}: {
  readOnly: boolean;
  canPaste: boolean;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onCopyPath: () => void;
  onCopyRelativePath: () => void;
  /** Tab-only: the tree row is already revealed by definition. */
  onReveal?: () => void;
  /** Compilable-file-only: edit this file's project-scoped command slots. */
  onCompilationSettings?: () => void;
  onRename: () => void;
  onDelete: () => void;
  onDownload: () => void;
}) {
  return (
    <>
      {!readOnly && (
        <>
          <ContextMenuItem onSelect={onCut}>
            Cut <Shortcut>⌘X</Shortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={onCopy}>
            Copy <Shortcut>⌘C</Shortcut>
          </ContextMenuItem>
          <ContextMenuItem disabled={!canPaste} onSelect={onPaste}>
            Paste <Shortcut>⌘V</Shortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuItem onSelect={onCopyPath}>
        Copy Path <Shortcut>⌥⌘C</Shortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={onCopyRelativePath}>
        Copy Relative Path <Shortcut>⌥⇧⌘C</Shortcut>
      </ContextMenuItem>
      {onReveal && <ContextMenuItem onSelect={onReveal}>Reveal in Filetree</ContextMenuItem>}
      {onCompilationSettings && (
        <ContextMenuItem onSelect={onCompilationSettings}>Compilation Settings…</ContextMenuItem>
      )}
      <ContextMenuSeparator />
      {!readOnly && (
        <>
          <ContextMenuItem onSelect={onRename}>
            Rename… <Shortcut>F2</Shortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={onDelete}>
            Delete <Shortcut>⌘⌫</Shortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuItem onSelect={onDownload}>Download</ContextMenuItem>
    </>
  );
}
