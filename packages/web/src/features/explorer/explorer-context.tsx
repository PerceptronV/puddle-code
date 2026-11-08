import type { CompilationFileTarget, GitStatus, Session } from '@puddle/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type KeyboardEvent as ReactKeyboardEvent,
  type ComponentProps,
} from 'react';
import { useDaemonVersion } from '../../lib/queries/queries';
import { useWorktreeGitStatus } from '../../lib/queries/worktree-queries';
import { sourceControlSupported } from '../../lib/transport/protocol-support';
import { type ExplorerClipboardState } from './clipboard-store';
import { type VisibleRow } from './explorer-paths';
import { buildStatusMap } from './git-decoration';
import { useExplorerActions } from './use-explorer-actions';
import { useExplorerInteraction } from './use-explorer-interaction';
import { useExplorerNavigation } from './use-explorer-navigation';

/** An in-flight inline edit: renaming an existing row, or naming a new entry under a folder. */
export type EditingState =
  { mode: 'rename'; path: string } | { mode: 'create'; parentDir: string; kind: 'file' | 'dir' };

/** The reactive tree view and its semantic actions, provided once by `ExplorerProvider`. */
export interface ExplorerCtx {
  sid: string;
  projectId: string;
  /**
   * Absolute path every row is relative to: the session's worktree, or the
   * browse `root` when the tree is showing a directory above it (SPEC §8).
   */
  rootPath: string;
  /**
   * The `?root=` override to send with every request, or undefined in the
   * worktree (where the session id alone names the root). Tree rows pass it
   * to their own queries; `useExplorerFs` sends it with each mutation.
   */
  root: string | undefined;
  /**
   * No mutations offered: the menus drop create/rename/delete/clipboard, rows
   * stop being drag sources, and drops stop uploading. Set when browsing above
   * the worktree against a daemon older than protocol 12.3, which would resolve
   * those paths against the WORKTREE and silently touch the wrong files.
   */
  readOnly: boolean;
  onOpenFile?: (sid: string, path: string, opts?: { preview?: boolean }) => void;
  /** Spawn a terminal whose shell starts in this worktree-relative directory. */
  onOpenTerminal?: (dir: string) => void;
  activePath: string | null;
  /** Extensions currently claimed by available daemon compilation providers. */
  compilableExtensions: ReadonlySet<string>;
  onOpenCompilationSettings?: (source: CompilationFileTarget) => void;

  expanded: ReadonlySet<string>;
  toggle(path: string): void;
  collapseAll(): void;

  statusMap: ReadonlyMap<string, GitStatus>;
  visibleRows: VisibleRow[];

  selection: ReadonlySet<string>;
  focusedPath: string | null;
  onRowClick(
    row: VisibleRow,
    /** `detail` is the click count — 2 marks a double-click's second click. */
    e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; detail?: number },
  ): void;
  /** Double-click a file row: promote its preview tab to a permanent one (VSCode-style). */
  onRowDoubleClick(row: VisibleRow): void;
  /** Select a single row without activating it (right-click, before a context menu). */
  selectOnly(path: string): void;

  clipboard: ExplorerClipboardState | null;
  canPaste: boolean;
  isCut(path: string): boolean;
  cut(paths: string[]): void;
  copy(paths: string[]): void;
  paste(targetDir: string): void;

  editing: EditingState | null;
  beginRename(path: string): void;
  beginCreate(parentDir: string, kind: 'file' | 'dir'): void;
  cancelEdit(): void;
  commitEdit(name: string): void;

  requestDelete(paths: string[]): void;
  /** Copy the given paths (absolute or worktree-relative), one per line. */
  copyPathToClipboard(paths: string[], relative: boolean): void;
  /** Download each path in turn (a directory arrives as a zip). */
  download(paths: string[]): void;
  refresh(): void;

  onUpload(dir: string, files: File[]): void;
  /**
   * OS drop into `dir`: resolves the DataTransfer — walking dropped folders
   * when the daemon supports them — then uploads. Call it synchronously from
   * the event handler (the DataTransfer is only readable during dispatch).
   */
  onDropUpload(dir: string, items: DataTransferItemList | undefined, files: FileList): void;
  /** Upload native clipboard files, or fall back to the internal cut/copy clipboard. */
  onClipboardPaste(items: DataTransferItemList | undefined, files: FileList): boolean;
  dropTarget: string | null;
  setDropTarget(path: string | null): void;
  onInternalDrop(targetDir: string, draggedPaths: string[]): void;

  handleKeyDown(e: ReactKeyboardEvent): void;

  /** Delete-confirmation state, rendered by the provider's dialog. */
  pendingDelete: string[] | null;
  confirmDelete(): void;
  cancelDelete(): void;
}

const Ctx = createContext<ExplorerCtx | null>(null);
const ControlsCtx = createContext<Pick<ExplorerCtx, 'refresh' | 'collapseAll'> | null>(null);

export function useExplorer(): ExplorerCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('explorer components must render inside <ExplorerProvider>');
  return ctx;
}

/** Optional variant for shared chrome (e.g. the header) that may render outside files mode. */
export function useExplorerControlsOptional(): Pick<ExplorerCtx, 'refresh' | 'collapseAll'> | null {
  return useContext(ControlsCtx);
}

/** Each directory owns its selection, pending gestures and confirmations. */
export function ExplorerProvider(props: ComponentProps<typeof ExplorerScope>) {
  return (
    <ExplorerScope
      key={JSON.stringify([
        props.session.id,
        props.root,
        props.root ?? props.session.worktree_path,
      ])}
      {...props}
    />
  );
}

function ExplorerScope({
  session,
  root,
  readOnly = false,
  onOpenFile,
  onOpenTerminal,
  compilableExtensions,
  onOpenCompilationSettings,
  activePath,
  children,
}: {
  session: Session;
  /**
   * Browse a directory ABOVE the session's worktree instead of the worktree
   * itself (SPEC §8): every row, query, and mutation is resolved against this
   * absolute path via `?root=`. Omit it for the worktree.
   */
  root?: string;
  /** Offer no mutations — see `ExplorerCtx.readOnly`. */
  readOnly?: boolean;
  onOpenFile?: (sid: string, path: string, opts?: { preview?: boolean }) => void;
  onOpenTerminal?: (dir: string) => void;
  compilableExtensions: ReadonlySet<string>;
  onOpenCompilationSettings?: (source: CompilationFileTarget) => void;
  activePath: string | null;
  children: React.ReactNode;
}) {
  const sid = session.id;
  const qc = useQueryClient();
  const rootPath = root ?? session.worktree_path;
  const navigation = useExplorerNavigation(sid, root);
  const actions = useExplorerActions({ sid, root, rootPath, readOnly, onOpenFile, navigation });
  const interaction = useExplorerInteraction({
    sid,
    root,
    rootPath,
    readOnly,
    onOpenFile,
    navigation,
    actions,
  });
  const protocol = useDaemonVersion().data?.protocol;
  // Protocol 15.3 rebases every owning/nested repository to the visible root,
  // so project and parent-directory targets get honest decorations too. Older
  // daemons retain the worktree-only request to avoid coincidental path matches.
  const statusQuery = useWorktreeGitStatus(sid, {
    root,
    enabled: root === undefined || (protocol !== undefined && sourceControlSupported(protocol)),
  });
  const statusMap = useMemo(
    () => buildStatusMap(statusQuery.data?.entries ?? []),
    [statusQuery.data],
  );
  const refetchStatus = statusQuery.refetch;

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['wt-tree', sid] });
    // This mounted query is the decoration map the visible tree is actually
    // rendering, including a root-qualified parent-directory browse. Refetch
    // it directly so the Refresh button does not rely on invalidation's
    // active-query scheduling to update Git state.
    void refetchStatus();
  }, [qc, sid, refetchStatus]);

  const value: ExplorerCtx = {
    sid,
    projectId: session.project_id,
    rootPath,
    root,
    readOnly,
    onOpenFile,
    onOpenTerminal,
    activePath,
    compilableExtensions,
    onOpenCompilationSettings,
    statusMap,
    refresh,
    expanded: navigation.expanded,
    selection: navigation.selection,
    focusedPath: navigation.focusedPath,
    visibleRows: navigation.visibleRows,
    toggle: navigation.toggle,
    collapseAll: navigation.collapseAll,
    selectOnly: navigation.selectOnly,
    ...actions,
    ...interaction,
  };
  const controls = useMemo(
    () => ({ refresh, collapseAll: navigation.collapseAll }),
    [refresh, navigation.collapseAll],
  );
  return (
    <ControlsCtx.Provider value={controls}>
      <Ctx.Provider value={value}>{children}</Ctx.Provider>
    </ControlsCtx.Provider>
  );
}
