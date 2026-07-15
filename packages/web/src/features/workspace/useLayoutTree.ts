import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LayoutLeaf, LayoutNode, TabRef } from '@puddle/shared';
import type { EditorTab } from '../editor/editor-tabs';
import type { UiStateHandle } from './use-ui-state';
import {
  addTabToLeaf,
  allLeaves,
  buildInitialTree,
  closeTab,
  dropTab,
  findLeaf,
  focusTab,
  leafContainingKey,
  makeLeaf,
  pruneTabs,
  resizeSplit,
  tabRefKey,
  type DropSpec,
} from './layout-tree';

/**
 * The tiling layout controller (SPEC §8): owns the `layout_tree`, the focused
 * leaf, and the composite operations Workspace drives (open a file, activate/
 * close a tab, ensure/remove a terminal, prune dead sessions, resize). The tree
 * in `ui_state` is the single source of truth for what is open and where;
 * persistence rides the existing debounced ui-state path. Legacy snapshots
 * (`layout_tree === null`) migrate once via `buildInitialTree`.
 */
export interface LayoutController {
  tree: LayoutNode;
  focusedLeaf: LayoutLeaf;
  /** The focused leaf's active tab, when it is an editor — for the sidebar highlight. */
  activeEditorTab: EditorTab | null;
  focusLeaf(leafId: string): void;
  activate(leafId: string, ref: TabRef): void;
  close(leafId: string, ref: TabRef): void;
  openEditor(tab: EditorTab): void;
  ensureTerminal(session: string): void;
  removeTerminal(session: string): void;
  pruneSessions(alive: ReadonlySet<string>): void;
  resize(splitId: string, sizes: number[]): void;
  drop(spec: DropSpec): void;
}

export function useLayoutTree(uiState: UiStateHandle): LayoutController {
  const snapshot = uiState.snapshot;

  // Compute the migration tree at most once (stable ids) until it is persisted.
  const initialRef = useRef<LayoutNode | null>(null);
  if (!snapshot.layout_tree && !initialRef.current) {
    initialRef.current = buildInitialTree(snapshot);
  }
  const tree = snapshot.layout_tree ?? initialRef.current ?? makeLeaf([]);

  const persist = useCallback(
    (next: LayoutNode) => uiState.update({ layout_tree: next }),
    [uiState],
  );

  // Persist the migrated tree once, when loaded, so its ids stabilise in storage.
  useEffect(() => {
    if (uiState.loaded && !snapshot.layout_tree && initialRef.current) {
      persist(initialRef.current);
    }
  }, [uiState.loaded, snapshot.layout_tree, persist]);

  const [focusedLeafId, setFocusedLeafId] = useState<string | null>(null);
  const focusedLeaf =
    (focusedLeafId ? findLeaf(tree, focusedLeafId) : null) ?? allLeaves(tree)[0] ?? makeLeaf([]);

  const activeRef = focusedLeaf.tabs.find((t) => tabRefKey(t) === focusedLeaf.activeKey) ?? null;
  const activeEditorTab = activeRef?.type === 'editor' ? activeRef.tab : null;

  return useMemo<LayoutController>(
    () => ({
      tree,
      focusedLeaf,
      activeEditorTab,
      focusLeaf: (leafId) => setFocusedLeafId(leafId),
      activate: (leafId, ref) => {
        setFocusedLeafId(leafId);
        const key = tabRefKey(ref);
        const leaf = findLeaf(tree, leafId);
        if (leaf && leaf.activeKey === key) return; // already active — no tree change
        persist(focusTab(tree, leafId, key));
      },
      close: (leafId, ref) => persist(closeTab(tree, leafId, tabRefKey(ref))),
      openEditor: (tab) => {
        const target = focusedLeaf.id;
        setFocusedLeafId(target);
        persist(addTabToLeaf(tree, target, { type: 'editor', tab }));
      },
      ensureTerminal: (session) => {
        const key = `term:${session}`;
        const existing = leafContainingKey(tree, key);
        if (existing) {
          setFocusedLeafId(existing.id);
          if (existing.activeKey !== key) persist(focusTab(tree, existing.id, key)); // else no-op
        } else {
          const target = focusedLeaf.id;
          setFocusedLeafId(target);
          persist(addTabToLeaf(tree, target, { type: 'terminal', session }));
        }
      },
      removeTerminal: (session) => {
        const leaf = leafContainingKey(tree, `term:${session}`);
        if (leaf) persist(closeTab(tree, leaf.id, `term:${session}`));
      },
      pruneSessions: (alive) =>
        persist(
          pruneTabs(tree, (ref) =>
            ref.type === 'terminal' ? alive.has(ref.session) : alive.has(ref.tab.session),
          ),
        ),
      resize: (splitId, sizes) => persist(resizeSplit(tree, splitId, sizes)),
      drop: (spec) => {
        setFocusedLeafId(spec.toLeafId);
        persist(dropTab(tree, spec));
      },
    }),
    [tree, focusedLeaf, activeEditorTab, persist],
  );
}
