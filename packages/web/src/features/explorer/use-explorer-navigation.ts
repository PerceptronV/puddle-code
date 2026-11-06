import type { TreeResponse } from '@puddle/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ancestorDirs, buildVisibleRows, rangeBetween } from './explorer-paths';
import type { RevealRequest } from '../../lib/navigation/reveal-in-tree';

/** Owns visible rows, expansion and selection; callers use semantic navigation actions. */
export function useExplorerNavigation(sid: string, root: string | undefined) {
  const qc = useQueryClient();
  // Every tree query is keyed by root when one is set, matching
  // `useWorktreeTree` — so a browse of `/Users/me` and the worktree tree can be
  // cached side by side without either serving the other's rows.
  const treeKey = useCallback(
    (dir: string) => (root === undefined ? ['wt-tree', sid, dir] : ['wt-tree', sid, dir, root]),
    [sid, root],
  );

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const anchorRef = useRef<string | null>(null);
  // Recompute the flat visible-row list whenever the expansion set changes or a
  // directory's tree query lands (subscribe to the cache for the latter).
  const [rowsVersion, setRowsVersion] = useState(0);
  useEffect(() => {
    const unsub = qc.getQueryCache().subscribe((event) => {
      // Only query-state events can change what `getQueryData` returns. The
      // observer* events fire during React renders themselves (`useQuery`
      // re-emits `observerOptionsUpdated` on every render because its inline
      // `queryFn` defeats the shallow options comparison) — bumping state on
      // those turns render → event → bump → render into a busy-loop that pins
      // a core for as long as the explorer is mounted.
      if (event.type !== 'added' && event.type !== 'removed' && event.type !== 'updated') return;
      const key = event.query.queryKey;
      if (Array.isArray(key) && key[0] === 'wt-tree' && key[1] === sid && key[3] === root) {
        setRowsVersion((v) => v + 1);
      }
    });
    return unsub;
  }, [qc, sid, root]);
  const visibleRows = useMemo(
    () => buildVisibleRows((dir) => qc.getQueryData<TreeResponse>(treeKey(dir)), expanded),
    // rowsVersion invalidates the memo when cache data changes under the same key set.
    [qc, treeKey, expanded, rowsVersion],
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

  const selectOnly = useCallback((path: string) => {
    setSelection(new Set([path]));
    setFocusedPath(path);
    anchorRef.current = path;
  }, []);

  const selectClick = useCallback(
    (path: string, e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => {
      setFocusedPath(path);
      if (e.metaKey || e.ctrlKey) {
        setSelection((prev) => {
          const next = new Set(prev);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
        anchorRef.current = path;
        return true;
      }
      if (e.shiftKey && anchorRef.current) {
        setSelection(new Set(rangeBetween(visibleRows, anchorRef.current, path)));
        return true;
      }
      return false;
    },
    [visibleRows],
  );
  const focus = useCallback(
    (index: number, extend: boolean) => {
      const row = visibleRows[Math.max(0, Math.min(visibleRows.length - 1, index))];
      if (!row) return;
      setFocusedPath(row.path);
      if (extend && anchorRef.current) {
        setSelection(new Set(rangeBetween(visibleRows, anchorRef.current, row.path)));
      } else {
        setSelection(new Set([row.path]));
        anchorRef.current = row.path;
      }
    },
    [visibleRows],
  );
  const [revealing, setRevealing] = useState<string | null>(null);
  const reveal = useCallback(
    (request: RevealRequest) => {
      for (const dir of ancestorDirs(request.path)) expand(dir);
      if (request.expandTarget && request.path !== '') expand(request.path);
      selectOnly(request.path);
      setRevealing(request.path);
    },
    [expand, selectOnly],
  );
  // The row cannot be scrolled to until it EXISTS: each newly expanded directory
  // fetches its children, so the run of `visibleRows` changes is what this waits
  // on. It gives up a few seconds after the tree stops changing rather than
  // watching forever for a path that has since been deleted or renamed.
  useEffect(() => {
    if (revealing === null) return;
    const row = document.querySelector(
      `[data-explorer-root] [data-path="${CSS.escape(revealing)}"]`,
    );
    if (row) {
      row.scrollIntoView({ block: 'nearest' });
      setRevealing(null);
      return;
    }
    const id = window.setTimeout(() => setRevealing(null), 4000);
    return () => window.clearTimeout(id);
  }, [revealing, visibleRows]);

  // Selection to act on for keyboard ops: the multi-selection if it holds the
  // focused row, else just the focused row (so a shortcut always targets what
  // the eye is on).
  const actionTargets = useCallback((): string[] => {
    if (focusedPath && selection.has(focusedPath)) return [...selection];
    if (focusedPath) return [focusedPath];
    return [...selection];
  }, [focusedPath, selection]);

  return {
    treeKey,
    expanded,
    selection,
    focusedPath,
    visibleRows,
    toggle,
    expand,
    collapseAll,
    selectOnly,
    selectClick,
    focus,
    reveal,
    actionTargets,
  };
}
export type ExplorerNavigation = ReturnType<typeof useExplorerNavigation>;
