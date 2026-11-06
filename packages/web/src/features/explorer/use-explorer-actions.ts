import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, useRef, useLayoutEffect } from 'react';
import { toast } from 'sonner';
import { useDaemonVersion, useHostInfo } from '../../lib/queries/queries';
import { downloadPath, uploadFiles } from '../../lib/queries/worktree-queries';
import { crossFiletreeTransferSupported } from '../../lib/transport/protocol-support';
import {
  confirmedSameDaemonHost,
  finishExplorerCut,
  hostIdentity,
  sameDaemonHost,
  sameFiletree,
  setExplorerClipboard,
  useExplorerClipboard,
  type ExplorerClipboardTarget,
} from './clipboard-store';
import { collectDroppedFiles, collectPastedFiles, hasPastedFiles } from './drop-files';
import { basename, joinPath, pruneNested } from './explorer-paths';
import { canMoveInto, useExplorerFs } from './use-explorer-fs';
import type { EditingState, ExplorerCtx } from './explorer-context';
import type { ExplorerNavigation } from './use-explorer-navigation';

/** Owns file-operation intent, clipboard admission and confirmations for one tree. */
export function useExplorerActions({
  sid,
  root,
  rootPath,
  readOnly,
  onOpenFile,
  navigation,
}: {
  sid: string;
  root: string | undefined;
  rootPath: string;
  readOnly: boolean;
  onOpenFile: ExplorerCtx['onOpenFile'];
  navigation: ExplorerNavigation;
}) {
  const mounted = useRef(false);
  const writable = useRef(!readOnly);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    writable.current = !readOnly;
  }, [readOnly]);
  const qc = useQueryClient();
  const fs = useExplorerFs(sid, root, rootPath);
  const { treeKey, expand, focusedPath, visibleRows } = navigation;
  const onUpload = useCallback(
    (dir: string, files: File[]) => {
      if (files.length === 0 || readOnly || !mounted.current || !writable.current) return;
      uploadFiles(sid, dir, files, root)
        .then(() => {
          void qc.invalidateQueries({ queryKey: treeKey(dir) });
          void qc.invalidateQueries({ queryKey: ['wt-git-status', sid] });
          toast.success(
            files.length === 1 ? `Uploaded ${files[0]!.name}` : `Uploaded ${files.length} files`,
          );
        })
        .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Upload failed'));
    },
    [sid, root, readOnly, qc, treeKey],
  );

  // Folder drops need the daemon to honour relative upload paths (9.2); on an
  // older daemon collectDroppedFiles falls back to rejecting folders. Unknown
  // (still fetching) reads as supported — version skew within a major is rare.
  const version = useDaemonVersion();
  const protocol = version.data?.protocol;
  const host = useHostInfo();
  const target = useMemo<ExplorerClipboardTarget>(
    () => ({ sid, root, directory: rootPath, host: hostIdentity(host.data) }),
    [sid, root, rootPath, host.data],
  );
  const foldersSupported =
    !protocol || protocol.major > 9 || (protocol.major === 9 && protocol.minor >= 2);

  const onDropUpload = useCallback(
    (dir: string, items: DataTransferItemList | undefined, files: FileList) => {
      collectDroppedFiles(items, files, foldersSupported)
        .then((collected) => onUpload(dir, collected))
        .catch((e: unknown) =>
          toast.error(e instanceof Error ? e.message : "Couldn't read the dropped folder"),
        );
    },
    [onUpload, foldersSupported],
  );

  const clipboard = useExplorerClipboard();
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);
  // A drag released outside the tree — over a pane, over nothing, or cancelled
  // with Esc — fires no `dragleave` on the row it was last over, which left that
  // row highlighted for good. `dragend` fires on the source for every outcome,
  // so it is the one signal that always disarms the highlight.
  useEffect(() => {
    const clear = () => setDropTarget(null);
    window.addEventListener('dragend', clear);
    return () => window.removeEventListener('dragend', clear);
  }, []);

  // Prune nested paths so a selection of a folder plus its children acts on
  // the folder once (pasting/moving/deleting the parent already covers them).
  const cut = useCallback(
    (paths: string[]) => setExplorerClipboard(pruneNested(paths), 'cut', target),
    [target],
  );
  const copy = useCallback(
    (paths: string[]) => setExplorerClipboard(pruneNested(paths), 'copy', target),
    [target],
  );
  const clipboardFromThisHost = clipboard !== null && sameDaemonHost(clipboard.source, target);
  const clipboardFromThisTree = clipboard !== null && sameFiletree(clipboard.source, target);
  const canPaste =
    !readOnly &&
    ((clipboardFromThisHost && clipboardFromThisTree) ||
      (clipboard !== null &&
        confirmedSameDaemonHost(clipboard.source, target) &&
        crossFiletreeTransferSupported(protocol)));
  const isCut = useCallback(
    (path: string) =>
      clipboard?.mode === 'cut' &&
      sameDaemonHost(clipboard.source, target) &&
      sameFiletree(clipboard.source, target) &&
      clipboard.paths.includes(path),
    [clipboard, target],
  );
  // The mutating entry points all short-circuit under `readOnly`, so a keyboard
  // shortcut or a stale menu can never reach `fs` — the menus merely stop
  // OFFERING them.
  const paste = useCallback(
    (targetDir: string) => {
      if (!clipboard || readOnly) return;
      const sameTree = sameFiletree(clipboard.source, target);
      if (!sameDaemonHost(clipboard.source, target)) {
        toast.error('That filetree clipboard belongs to another daemon host.');
        return;
      }
      if (!sameTree && !confirmedSameDaemonHost(clipboard.source, target)) {
        toast.error('Copy again after daemon host information finishes loading.');
        return;
      }
      if (!sameTree && !crossFiletreeTransferSupported(protocol)) {
        toast.error('Cross-filetree paste requires a daemon with protocol 16.3.');
        return;
      }
      void fs.paste(clipboard, targetDir).then((failedPaths) => {
        if (clipboard.mode === 'cut') finishExplorerCut(clipboard.id, failedPaths);
      });
    },
    [clipboard, fs, protocol, readOnly, target],
  );

  const onClipboardPaste = useCallback<ExplorerCtx['onClipboardPaste']>(
    (items, files) => {
      // A rename/create input owns ordinary text paste while it is mounted.
      if (readOnly || editing) return false;
      const focusedRow = focusedPath
        ? visibleRows.find((row) => row.path === focusedPath)
        : undefined;
      const targetDir = focusedRow
        ? focusedRow.type === 'dir'
          ? focusedRow.path
          : focusedRow.parentDir
        : '';

      // Native clipboard files win over Puddle's persistent tree clipboard.
      // Capture them before returning from this dispatch; Chromium invalidates
      // DataTransferItem access after the paste event has unwound.
      if (hasPastedFiles(items, files)) {
        collectPastedFiles(items, files, foldersSupported)
          .then((collected) => onUpload(targetDir, collected))
          .catch((e: unknown) =>
            toast.error(e instanceof Error ? e.message : "Couldn't read the pasted files"),
          );
        return true;
      }
      if (canPaste) {
        paste(targetDir);
        return true;
      }
      return false;
    },
    [readOnly, editing, focusedPath, visibleRows, foldersSupported, onUpload, canPaste, paste],
  );

  const beginRename = useCallback(
    (path: string) => {
      if (!readOnly) setEditing({ mode: 'rename', path });
    },
    [readOnly],
  );
  const beginCreate = useCallback(
    (parentDir: string, kind: 'file' | 'dir') => {
      if (readOnly) return;
      if (parentDir !== '') expand(parentDir);
      setEditing({ mode: 'create', parentDir, kind });
    },
    [expand, readOnly],
  );
  const cancelEdit = useCallback(() => setEditing(null), []);
  const commitEdit = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      const current = editing;
      setEditing(null);
      if (readOnly || !current || trimmed === '') return;
      if (current.mode === 'rename') {
        if (trimmed === basename(current.path)) return;
        void fs.rename(current.path, trimmed);
      } else {
        void fs.create(current.parentDir, trimmed, current.kind).then((created) => {
          if (created && current.kind === 'file' && mounted.current) onOpenFile?.(sid, created);
        });
      }
    },
    [editing, fs, onOpenFile, sid, readOnly],
  );

  const requestDelete = useCallback(
    (paths: string[]) => {
      if (readOnly) return;
      const pruned = pruneNested(paths);
      if (pruned.length > 0) setPendingDelete(pruned);
    },
    [readOnly],
  );
  const confirmDelete = useCallback(() => {
    const paths = pendingDelete;
    setPendingDelete(null);
    if (paths && !readOnly) void fs.remove(paths);
  }, [pendingDelete, fs, readOnly]);
  const cancelDelete = useCallback(() => setPendingDelete(null), []);

  const copyPathToClipboard = useCallback(
    (paths: string[], relative: boolean) => {
      const text = paths.map((p) => (relative ? p : joinPath(rootPath, p))).join('\n');
      void navigator.clipboard.writeText(text);
      const label = relative ? 'Relative path' : 'Path';
      toast.success(
        paths.length > 1 ? `${paths.length} ${label.toLowerCase()}s copied` : `${label} copied`,
      );
    },
    [rootPath],
  );
  const download = useCallback(
    (paths: string[]) => {
      // Sequential, not parallel — several simultaneous programmatic anchor
      // clicks make browsers drop all but the last download.
      void (async () => {
        for (const path of pruneNested(paths)) await downloadPath(sid, path, root);
      })().catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Download failed'));
    },
    [sid, root],
  );
  const onInternalDrop = useCallback(
    (targetDir: string, draggedPaths: string[]) => {
      if (readOnly) return;
      const movable = pruneNested(draggedPaths).filter((p) => canMoveInto(p, targetDir));
      if (movable.length > 0) void fs.move(movable, targetDir);
    },
    [fs, readOnly],
  );

  return {
    clipboard,
    canPaste,
    isCut,
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
    onUpload,
    onDropUpload,
    onClipboardPaste,
    dropTarget,
    setDropTarget,
    onInternalDrop,
    pendingDelete,
    confirmDelete,
    cancelDelete,
  };
}
export type ExplorerActions = ReturnType<typeof useExplorerActions>;
