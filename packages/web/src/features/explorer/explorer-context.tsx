import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { GitStatus, Session, TreeResponse } from '@puddle/shared';
import { downloadPath, uploadFiles, useWorktreeGitStatus } from '../../lib/worktree-queries';
import { buildStatusMap } from './git-decoration';
import {
  basename,
  buildVisibleRows,
  joinPath,
  rangeBetween,
  type VisibleRow,
} from './explorer-paths';
import { canMoveInto, useExplorerFs } from './use-explorer-fs';

export interface ClipboardState {
  paths: string[];
  mode: 'cut' | 'copy';
}

/** An in-flight inline edit: renaming an existing row, or naming a new entry under a folder. */
export type EditingState =
  { mode: 'rename'; path: string } | { mode: 'create'; parentDir: string; kind: 'file' | 'dir' };

/** Everything a tree row and the header need, provided once by `ExplorerProvider`. */
export interface ExplorerCtx {
  sid: string;
  worktreePath: string;
  onOpenFile?: (sid: string, path: string, opts?: { preview?: boolean }) => void;
  activePath: string | null;

  expanded: ReadonlySet<string>;
  toggle(path: string): void;
  collapseAll(): void;

  statusMap: ReadonlyMap<string, GitStatus>;
  visibleRows: VisibleRow[];

  selection: ReadonlySet<string>;
  focusedPath: string | null;
  onRowClick(row: VisibleRow, e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): void;
  /** Double-click a file row: promote its preview tab to a permanent one (VSCode-style). */
  onRowDoubleClick(row: VisibleRow): void;
  /** Select a single row without activating it (right-click, before a context menu). */
  selectOnly(path: string): void;

  clipboard: ClipboardState | null;
  cut(paths: string[]): void;
  copy(paths: string[]): void;
  paste(targetDir: string): void;

  editing: EditingState | null;
  beginRename(path: string): void;
  beginCreate(parentDir: string, kind: 'file' | 'dir'): void;
  cancelEdit(): void;
  commitEdit(name: string): void;

  requestDelete(paths: string[]): void;
  copyPathToClipboard(path: string, relative: boolean): void;
  download(path: string): void;
  refresh(): void;

  onUpload(dir: string, files: File[]): void;
  dropTarget: string | null;
  setDropTarget(path: string | null): void;
  onInternalDrop(targetDir: string, draggedPath: string): void;

  handleKeyDown(e: ReactKeyboardEvent): void;

  /** Delete-confirmation state, rendered by the provider's dialog. */
  pendingDelete: string[] | null;
  confirmDelete(): void;
  cancelDelete(): void;
}

const Ctx = createContext<ExplorerCtx | null>(null);

export function useExplorer(): ExplorerCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('explorer components must render inside <ExplorerProvider>');
  return ctx;
}

/** Optional variant for shared chrome (e.g. the header) that may render outside files mode. */
export function useExplorerOptional(): ExplorerCtx | null {
  return useContext(Ctx);
}

export function ExplorerProvider({
  session,
  onOpenFile,
  activePath,
  children,
}: {
  session: Session;
  onOpenFile?: (sid: string, path: string, opts?: { preview?: boolean }) => void;
  activePath: string | null;
  children: React.ReactNode;
}) {
  const sid = session.id;
  const qc = useQueryClient();
  const fs = useExplorerFs(sid);

  const onUpload = useCallback(
    (dir: string, files: File[]) => {
      if (files.length === 0) return;
      uploadFiles(sid, dir, files)
        .then(() => {
          void qc.invalidateQueries({ queryKey: ['wt-tree', sid, dir] });
          void qc.invalidateQueries({ queryKey: ['wt-git-status', sid] });
          toast.success(
            files.length === 1 ? `Uploaded ${files[0]!.name}` : `Uploaded ${files.length} files`,
          );
        })
        .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Upload failed'));
    },
    [sid, qc],
  );

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);
  const anchorRef = useRef<string | null>(null);

  const statusQuery = useWorktreeGitStatus(sid);
  const statusMap = useMemo(
    () => buildStatusMap(statusQuery.data?.entries ?? []),
    [statusQuery.data],
  );

  // Recompute the flat visible-row list whenever the expansion set changes or a
  // directory's tree query lands (subscribe to the cache for the latter).
  const [rowsVersion, setRowsVersion] = useState(0);
  useEffect(() => {
    const unsub = qc.getQueryCache().subscribe((event) => {
      const key = event.query.queryKey;
      if (Array.isArray(key) && key[0] === 'wt-tree' && key[1] === sid) {
        setRowsVersion((v) => v + 1);
      }
    });
    return unsub;
  }, [qc, sid]);
  const visibleRows = useMemo(
    () => buildVisibleRows((dir) => qc.getQueryData<TreeResponse>(['wt-tree', sid, dir]), expanded),
    // rowsVersion invalidates the memo when cache data changes under the same key set.
    [qc, sid, expanded, rowsVersion],
  );

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const expand = useCallback((path: string) => {
    setExpanded((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
  }, []);
  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  const onRowClick = useCallback<ExplorerCtx['onRowClick']>(
    (row, e) => {
      setFocusedPath(row.path);
      if (e.metaKey || e.ctrlKey) {
        setSelection((prev) => {
          const next = new Set(prev);
          if (next.has(row.path)) next.delete(row.path);
          else next.add(row.path);
          return next;
        });
        anchorRef.current = row.path;
        return;
      }
      if (e.shiftKey && anchorRef.current) {
        setSelection(new Set(rangeBetween(visibleRows, anchorRef.current, row.path)));
        return;
      }
      setSelection(new Set([row.path]));
      anchorRef.current = row.path;
      // A single click opens a file as an ephemeral preview tab (the default);
      // a directory toggles.
      if (row.type === 'dir') toggle(row.path);
      else onOpenFile?.(sid, row.path);
    },
    [visibleRows, toggle, onOpenFile, sid],
  );

  // A double click pins the file — opening it (or promoting its preview tab) as
  // a permanent tab, matching VSCode. Directories have no preview notion.
  const onRowDoubleClick = useCallback<ExplorerCtx['onRowDoubleClick']>(
    (row) => {
      if (row.type !== 'dir') onOpenFile?.(sid, row.path, { preview: false });
    },
    [onOpenFile, sid],
  );

  const selectOnly = useCallback((path: string) => {
    setSelection(new Set([path]));
    setFocusedPath(path);
    anchorRef.current = path;
  }, []);

  const cut = useCallback((paths: string[]) => setClipboard({ paths, mode: 'cut' }), []);
  const copy = useCallback((paths: string[]) => setClipboard({ paths, mode: 'copy' }), []);
  const paste = useCallback(
    (targetDir: string) => {
      if (!clipboard) return;
      void fs.paste(clipboard, targetDir).then(() => {
        if (clipboard.mode === 'cut') setClipboard(null);
      });
    },
    [clipboard, fs],
  );

  const beginRename = useCallback((path: string) => setEditing({ mode: 'rename', path }), []);
  const beginCreate = useCallback(
    (parentDir: string, kind: 'file' | 'dir') => {
      if (parentDir !== '') expand(parentDir);
      setEditing({ mode: 'create', parentDir, kind });
    },
    [expand],
  );
  const cancelEdit = useCallback(() => setEditing(null), []);
  const commitEdit = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      const current = editing;
      setEditing(null);
      if (!current || trimmed === '') return;
      if (current.mode === 'rename') {
        if (trimmed === basename(current.path)) return;
        void fs.rename(current.path, trimmed);
      } else {
        void fs.create(current.parentDir, trimmed, current.kind).then((created) => {
          if (created && current.kind === 'file') onOpenFile?.(sid, created);
        });
      }
    },
    [editing, fs, onOpenFile, sid],
  );

  const requestDelete = useCallback((paths: string[]) => {
    if (paths.length > 0) setPendingDelete(paths);
  }, []);
  const confirmDelete = useCallback(() => {
    const paths = pendingDelete;
    setPendingDelete(null);
    if (paths) void fs.remove(paths);
  }, [pendingDelete, fs]);
  const cancelDelete = useCallback(() => setPendingDelete(null), []);

  const copyPathToClipboard = useCallback(
    (path: string, relative: boolean) => {
      const text = relative ? path : joinPath(session.worktree_path, path);
      void navigator.clipboard.writeText(text);
      toast.success(relative ? 'Relative path copied' : 'Path copied');
    },
    [session.worktree_path],
  );
  const download = useCallback(
    (path: string) => {
      void downloadPath(sid, path).catch((e: unknown) =>
        toast.error(e instanceof Error ? e.message : 'Download failed'),
      );
    },
    [sid],
  );
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['wt-tree', sid] });
    void qc.invalidateQueries({ queryKey: ['wt-git-status', sid] });
  }, [qc, sid]);

  const onInternalDrop = useCallback(
    (targetDir: string, draggedPath: string) => {
      if (!canMoveInto(draggedPath, targetDir)) return;
      void fs.move(draggedPath, targetDir);
    },
    [fs],
  );

  // Selection to act on for keyboard ops: the multi-selection if it holds the
  // focused row, else just the focused row (so a shortcut always targets what
  // the eye is on).
  const actionTargets = useCallback((): string[] => {
    if (focusedPath && selection.has(focusedPath)) return [...selection];
    if (focusedPath) return [focusedPath];
    return [...selection];
  }, [focusedPath, selection]);

  const typeahead = useRef<{ buffer: string; at: number }>({ buffer: '', at: 0 });

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (editing) return; // the inline input owns the keyboard
      const rows = visibleRows;
      if (rows.length === 0) return;
      const idx = focusedPath ? rows.findIndex((r) => r.path === focusedPath) : -1;
      const focus = (i: number, extend: boolean) => {
        const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
        if (!row) return;
        setFocusedPath(row.path);
        if (extend && anchorRef.current) {
          setSelection(new Set(rangeBetween(rows, anchorRef.current, row.path)));
        } else {
          setSelection(new Set([row.path]));
          anchorRef.current = row.path;
        }
      };
      const cur = idx >= 0 ? rows[idx] : undefined;
      const meta = e.metaKey || e.ctrlKey;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          focus(idx + 1, e.shiftKey);
          return;
        case 'ArrowUp':
          e.preventDefault();
          focus(idx <= 0 ? 0 : idx - 1, e.shiftKey);
          return;
        case 'ArrowRight':
          e.preventDefault();
          if (cur?.type === 'dir' && !expanded.has(cur.path)) expand(cur.path);
          else if (cur?.type === 'dir') focus(idx + 1, false);
          return;
        case 'ArrowLeft':
          e.preventDefault();
          if (cur?.type === 'dir' && expanded.has(cur.path)) toggle(cur.path);
          else if (cur) {
            const parent = rows.findIndex((r) => r.path === cur.parentDir);
            if (parent >= 0) focus(parent, false);
          }
          return;
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (!cur) return;
          if (cur.type === 'dir') toggle(cur.path);
          else onOpenFile?.(sid, cur.path);
          return;
        case 'F2':
          e.preventDefault();
          if (cur) beginRename(cur.path);
          return;
        case 'Delete':
          e.preventDefault();
          requestDelete(actionTargets());
          return;
        case 'Backspace':
          if (meta) {
            e.preventDefault();
            requestDelete(actionTargets());
          }
          return;
      }

      if (meta && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        const targets = actionTargets();
        if (e.altKey) copyPathToClipboard(targets[0] ?? '', e.shiftKey);
        else copy(targets);
        return;
      }
      if (meta && (e.key === 'x' || e.key === 'X')) {
        e.preventDefault();
        cut(actionTargets());
        return;
      }
      if (meta && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        const targetDir = cur ? (cur.type === 'dir' ? cur.path : cur.parentDir) : '';
        paste(targetDir);
        return;
      }

      // Type-to-jump: match the next visible row by name prefix.
      if (!meta && !e.altKey && e.key.length === 1 && /\S/.test(e.key)) {
        const now = Date.now();
        const t = typeahead.current;
        t.buffer = now - t.at > 700 ? e.key : t.buffer + e.key;
        t.at = now;
        const needle = t.buffer.toLowerCase();
        const start = idx + 1;
        for (let n = 0; n < rows.length; n++) {
          const row = rows[(start + n) % rows.length]!;
          if (row.name.toLowerCase().startsWith(needle)) {
            focus(
              rows.findIndex((r) => r.path === row.path),
              false,
            );
            break;
          }
        }
      }
    },
    [
      editing,
      visibleRows,
      focusedPath,
      expanded,
      expand,
      toggle,
      onOpenFile,
      sid,
      beginRename,
      requestDelete,
      actionTargets,
      copy,
      cut,
      paste,
      copyPathToClipboard,
    ],
  );

  const value: ExplorerCtx = {
    sid,
    worktreePath: session.worktree_path,
    onOpenFile,
    activePath,
    expanded,
    toggle,
    collapseAll,
    statusMap,
    visibleRows,
    selection,
    focusedPath,
    onRowClick,
    onRowDoubleClick,
    selectOnly,
    clipboard,
    cut,
    copy,
    paste,
    editing,
    beginRename,
    beginCreate,
    cancelEdit,
    commitEdit,
    requestDelete,
    copyPathToClipboard,
    download,
    refresh,
    onUpload,
    dropTarget,
    setDropTarget,
    onInternalDrop,
    handleKeyDown,
    pendingDelete,
    confirmDelete,
    cancelDelete,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
