import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { clearPendingReveal, onReveal } from '../../lib/navigation/reveal-in-tree';
import { isSecondClick, type ClickStamp } from '../../lib/second-click';
import type { ExplorerCtx } from './explorer-context';
import type { ExplorerActions } from './use-explorer-actions';
import type { ExplorerNavigation } from './use-explorer-navigation';

/** Arbitrates gestures and shortcuts between navigation and file-operation controllers. */
export function useExplorerInteraction({
  sid,
  root,
  rootPath,
  readOnly,
  onOpenFile,
  navigation,
  actions,
}: {
  sid: string;
  root: string | undefined;
  rootPath: string;
  readOnly: boolean;
  onOpenFile: ExplorerCtx['onOpenFile'];
  navigation: ExplorerNavigation;
  actions: ExplorerActions;
}) {
  const {
    visibleRows,
    focusedPath,
    expanded,
    selection,
    toggle,
    expand,
    selectOnly,
    selectClick,
    focus,
    reveal,
    actionTargets,
  } = navigation;
  const { editing, beginRename, requestDelete, copy, cut, copyPathToClipboard } = actions;
  // Reveal requests are scoped to the actual tree before either navigation or editing acts.
  useEffect(
    () =>
      onReveal((request) => {
        if (
          request.directory !== undefined ? request.directory !== rootPath : request.root !== root
        )
          return;
        clearPendingReveal();
        reveal(request);
        if (request.renameTarget) beginRename(request.path);
      }),
    [root, rootPath, reveal, beginRename],
  );
  // Click-to-rename, FILES ONLY (SPEC §8). A plain click on the sole-selected
  // file row, when the previous click on it was recent (`isSecondClick`), starts
  // an inline rename after a beat — so the second click of a double-click (which
  // pins the file instead) can cancel it. Any other click cancels a pending
  // rename first: the timer must never fire for a row the user has moved on from.
  //
  // FOLDERS have no click gesture for renaming at all (decision 2026-08-04): a
  // folder's clicks belong to expand/collapse, and every variant tried fought
  // that — the second-click timer fired mid-toggle, and moving it to
  // double-click meant flipping a folder open and shut quickly opened a rename
  // box. The context menu's Rename… (and F2) is the whole story for a folder.
  const renameTimer = useRef<number | null>(null);
  const lastRowClick = useRef<ClickStamp | null>(null);
  const cancelPendingRename = useCallback(() => {
    if (renameTimer.current !== null) {
      window.clearTimeout(renameTimer.current);
      renameTimer.current = null;
    }
  }, []);
  useEffect(() => {
    if (readOnly) cancelPendingRename();
    return cancelPendingRename;
  }, [readOnly, cancelPendingRename]);

  const onRowClick = useCallback<ExplorerCtx['onRowClick']>(
    (row, e) => {
      cancelPendingRename();
      if (selectClick(row.path, e)) return;
      const now = Date.now();
      const prev = lastRowClick.current;
      lastRowClick.current = { id: row.path, at: now };
      if (
        row.type !== 'dir' &&
        !readOnly &&
        !editing &&
        selection.size === 1 &&
        selection.has(row.path) &&
        isSecondClick(prev, row.path, now)
      ) {
        renameTimer.current = window.setTimeout(() => {
          renameTimer.current = null;
          beginRename(row.path);
        }, 500);
        return;
      }
      selectOnly(row.path);
      // A single click opens a file as an ephemeral preview tab (the default);
      // a directory toggles on EVERY click, so double-clicking a folder opens
      // and closes it again — nothing else competes for a folder's clicks.
      if (row.type === 'dir') toggle(row.path);
      else onOpenFile?.(sid, row.path);
    },
    [
      selectClick,
      selectOnly,
      beginRename,
      toggle,
      onOpenFile,
      sid,
      selection,
      editing,
      readOnly,
      cancelPendingRename,
    ],
  );

  // A double click pins a FILE — opening it (or promoting its preview tab) as
  // a permanent tab, matching VSCode — and cancels a click-to-rename the
  // second click just scheduled. A FOLDER has nothing to do here: its two
  // clicks have already toggled it twice, which is the gesture.
  const onRowDoubleClick = useCallback<ExplorerCtx['onRowDoubleClick']>(
    (row) => {
      cancelPendingRename();
      if (row.type !== 'dir') onOpenFile?.(sid, row.path, { preview: false });
    },
    [onOpenFile, sid, cancelPendingRename],
  );

  const typeahead = useRef<{ buffer: string; at: number }>({ buffer: '', at: 0 });

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (editing) return; // the inline input owns the keyboard
      const rows = visibleRows;
      if (rows.length === 0) return;
      const idx = focusedPath ? rows.findIndex((r) => r.path === focusedPath) : -1;
      const cur = idx >= 0 ? rows[idx] : undefined;
      const meta = e.metaKey || e.ctrlKey;
      const browse = (index: number) => {
        cancelPendingRename();
        lastRowClick.current = null;
        const next = rows[Math.max(0, Math.min(index, rows.length - 1))];
        focus(index, e.shiftKey);
        // Range selection and modifier navigation never open a batch of files.
        if (!e.shiftKey && !meta && !e.altKey && next?.type !== 'dir' && next)
          onOpenFile?.(sid, next.path, { preview: true });
      };

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          browse(idx + 1);
          return;
        case 'ArrowUp':
          e.preventDefault();
          browse(idx <= 0 ? 0 : idx - 1);
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
          else onOpenFile?.(sid, cur.path, { preview: e.key !== 'Enter' });
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
        if (e.altKey) copyPathToClipboard(targets, e.shiftKey);
        else copy(targets);
        return;
      }
      if (meta && (e.key === 'x' || e.key === 'X')) {
        e.preventDefault();
        cut(actionTargets());
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
      focus,
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
      copyPathToClipboard,
      cancelPendingRename,
    ],
  );

  return { onRowClick, onRowDoubleClick, handleKeyDown };
}
