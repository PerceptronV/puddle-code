import type { LayoutLeaf, LayoutNode, LayoutSplit, TabRef, UiStateSnapshot } from '@puddle/shared';
import { tabKey, type EditorTab } from '../editor/editor-tabs';

/**
 * Pure, React/Monaco-free reducer for the tiling layout tree (SPEC §8) — the
 * analogue of `editor-tabs.ts`/`panel-layout.ts`, unit-tested under vitest. Every
 * op returns a NEW tree and runs `normalise`, which enforces the structural
 * invariants (single-child splits collapse, empty leaves drop except the sole
 * root, sizes track children, same-direction splits flatten, `activeKey` stays
 * valid). Node ids are stable across ops — only newly created nodes get fresh ids.
 */

export type DropEdge = 'top' | 'bottom' | 'left' | 'right' | 'center';

function newId(): string {
  return crypto.randomUUID();
}

// ---- Tab identity ---------------------------------------------------------

/** Stable key for a tab, unique across editors and terminals (registry + React keys + dedupe). */
export function tabRefKey(ref: TabRef): string {
  return ref.type === 'terminal' ? `term:${ref.session}` : `editor:${tabKey(ref.tab as EditorTab)}`;
}

export function sameRef(a: TabRef, b: TabRef): boolean {
  return tabRefKey(a) === tabRefKey(b);
}

export function isTerminal(ref: TabRef): boolean {
  return ref.type === 'terminal';
}

// ---- Constructors ---------------------------------------------------------

export function makeLeaf(tabs: TabRef[] = [], activeKey?: string | null): LayoutLeaf {
  const keys = tabs.map(tabRefKey);
  const active =
    activeKey && keys.includes(activeKey) ? activeKey : keys.length > 0 ? keys[0]! : null;
  // previewKey is null by default (matches the schema default, so a built tree
  // round-trips through uiStateSnapshotSchema unchanged).
  return { kind: 'leaf', id: newId(), tabs, activeKey: active, previewKey: null };
}

function makeSplit(
  direction: 'row' | 'col',
  children: LayoutNode[],
  sizes?: number[],
): LayoutSplit {
  return {
    kind: 'split',
    id: newId(),
    direction,
    children,
    sizes: sizes ?? children.map(() => 100 / Math.max(1, children.length)),
  };
}

// ---- Traversal ------------------------------------------------------------

export function findLeaf(node: LayoutNode, leafId: string): LayoutLeaf | null {
  if (node.kind === 'leaf') return node.id === leafId ? node : null;
  for (const child of node.children) {
    const found = findLeaf(child, leafId);
    if (found) return found;
  }
  return null;
}

export function leafContainingKey(node: LayoutNode, key: string): LayoutLeaf | null {
  if (node.kind === 'leaf') return node.tabs.some((t) => tabRefKey(t) === key) ? node : null;
  for (const child of node.children) {
    const found = leafContainingKey(child, key);
    if (found) return found;
  }
  return null;
}

/** Every leaf, left-to-right / top-to-bottom. */
export function allLeaves(node: LayoutNode): LayoutLeaf[] {
  if (node.kind === 'leaf') return [node];
  return node.children.flatMap(allLeaves);
}

/** Every tab across the whole tree in DFS order (feeds the keep-alive registry + model refcount). */
export function flattenTabs(node: LayoutNode): TabRef[] {
  return allLeaves(node).flatMap((leaf) => leaf.tabs);
}

// ---- Normalisation --------------------------------------------------------

function normaliseLeaf(leaf: LayoutLeaf): LayoutLeaf {
  const keys = leaf.tabs.map(tabRefKey);
  const activeKey =
    leaf.activeKey && keys.includes(leaf.activeKey) ? leaf.activeKey : (keys[0] ?? null);
  // A preview tab that has been closed or moved away stops being a preview.
  const previewKey = leaf.previewKey && keys.includes(leaf.previewKey) ? leaf.previewKey : null;
  if (activeKey === leaf.activeKey && previewKey === (leaf.previewKey ?? null)) return leaf;
  return { ...leaf, activeKey, previewKey };
}

/**
 * Enforce the tree invariants bottom-up: normalise children first, flatten any
 * same-direction child split (distributing its parent size across its children
 * by their internal ratios), drop empty leaves, then collapse a single-child
 * split to that child. A split that loses all children becomes a fresh empty
 * leaf; a top-level empty leaf is preserved (the empty-workspace state).
 */
export function normalise(node: LayoutNode): LayoutNode {
  if (node.kind === 'leaf') return normaliseLeaf(node);

  const normChildren = node.children.map(normalise);

  // Flatten same-direction splits.
  const flatChildren: LayoutNode[] = [];
  const flatSizes: number[] = [];
  normChildren.forEach((child, i) => {
    const size = node.sizes[i] ?? 1;
    if (child.kind === 'split' && child.direction === node.direction) {
      const inner = child.sizes.reduce((a, b) => a + b, 0) || child.children.length;
      child.children.forEach((gc, j) => {
        flatChildren.push(gc);
        flatSizes.push((size * (child.sizes[j] ?? 1)) / inner);
      });
    } else {
      flatChildren.push(child);
      flatSizes.push(size);
    }
  });

  // Drop empty leaves.
  const keptChildren: LayoutNode[] = [];
  const keptSizes: number[] = [];
  flatChildren.forEach((child, i) => {
    if (child.kind === 'leaf' && child.tabs.length === 0) return;
    keptChildren.push(child);
    keptSizes.push(flatSizes[i] ?? 1);
  });

  if (keptChildren.length === 0) return makeLeaf([]);
  if (keptChildren.length === 1) return keptChildren[0]!;
  return { ...node, children: keptChildren, sizes: keptSizes };
}

// ---- Structural edits -----------------------------------------------------

/** Replace the leaf `leafId` with `fn(leaf)` wherever it sits; identity elsewhere. */
function transformLeaf(
  node: LayoutNode,
  leafId: string,
  fn: (leaf: LayoutLeaf) => LayoutNode,
): LayoutNode {
  if (node.kind === 'leaf') return node.id === leafId ? fn(node) : node;
  return { ...node, children: node.children.map((c) => transformLeaf(c, leafId, fn)) };
}

/** Remove the tab `key` from every leaf that holds it (used for moves and close). */
function removeKeyEverywhere(node: LayoutNode, key: string): LayoutNode {
  if (node.kind === 'leaf') {
    if (!node.tabs.some((t) => tabRefKey(t) === key)) return node;
    const tabs = node.tabs.filter((t) => tabRefKey(t) !== key);
    const activeKey = node.activeKey === key ? neighbourKey(node, key) : node.activeKey;
    return { ...node, tabs, activeKey };
  }
  return { ...node, children: node.children.map((c) => removeKeyEverywhere(c, key)) };
}

/** The tab to activate after `key` leaves a leaf: right neighbour, else left, else null. */
function neighbourKey(leaf: LayoutLeaf, key: string): string | null {
  const idx = leaf.tabs.findIndex((t) => tabRefKey(t) === key);
  if (idx === -1) return leaf.activeKey;
  const remaining = leaf.tabs.filter((t) => tabRefKey(t) !== key);
  if (remaining.length === 0) return null;
  return tabRefKey(remaining[Math.min(idx, remaining.length - 1)]!);
}

function insertInLeaf(leaf: LayoutLeaf, ref: TabRef, index?: number): LayoutLeaf {
  const without = leaf.tabs.filter((t) => !sameRef(t, ref));
  const at = index === undefined ? without.length : Math.max(0, Math.min(index, without.length));
  const tabs = [...without.slice(0, at), ref, ...without.slice(at)];
  return { ...leaf, tabs, activeKey: tabRefKey(ref) };
}

/** Split `leafId` along `edge`, placing `ref` in the new sibling leaf. */
export function splitLeaf(
  tree: LayoutNode,
  leafId: string,
  edge: Exclude<DropEdge, 'center'>,
  ref: TabRef,
): LayoutNode {
  const direction = edge === 'left' || edge === 'right' ? 'row' : 'col';
  const before = edge === 'left' || edge === 'top';
  const next = transformLeaf(tree, leafId, (leaf) => {
    const fresh = makeLeaf([ref]);
    const children = before ? [fresh, leaf] : [leaf, fresh];
    return makeSplit(direction, children, [50, 50]);
  });
  return normalise(next);
}

export interface DropSpec {
  ref: TabRef;
  /** The leaf the tab was dragged from (for move-vs-duplicate + same-leaf reorder). */
  fromLeafId: string;
  toLeafId: string;
  edge: DropEdge;
  /** Insertion index for a `center` drop (strip reorder); appended when absent. */
  index?: number;
}

/**
 * The single drag-drop entry point. A terminal always MOVES (it is unique — the
 * WS manager is 1:1); an editor dropped into a DIFFERENT leaf DUPLICATES (models
 * are shared/refcounted), while an editor dropped back into its own leaf moves
 * (reorder). `center` inserts into the target leaf; an edge splits it.
 */
export function dropTab(tree: LayoutNode, spec: DropSpec): LayoutNode {
  const { ref, fromLeafId, toLeafId, edge, index } = spec;
  const move = isTerminal(ref) || fromLeafId === toLeafId;
  const withoutSource = move ? removeKeyEverywhere(tree, tabRefKey(ref)) : tree;

  // The target leaf may have been pruned if it emptied during the move (dragging
  // a lone tab onto its own leaf's edge) — normalise at the end restores sanity.
  if (edge === 'center') {
    const next = transformLeaf(withoutSource, toLeafId, (leaf) => insertInLeaf(leaf, ref, index));
    // If the target leaf vanished (moved its only tab), re-seed it.
    if (!findLeaf(next, toLeafId) && !leafContainingKey(next, tabRefKey(ref))) {
      return normalise(appendToFirstLeaf(next, ref));
    }
    return normalise(next);
  }
  if (!findLeaf(withoutSource, toLeafId)) {
    // Target leaf was the source and emptied; the ref becomes the whole content.
    return normalise(makeLeaf([ref]));
  }
  return splitLeaf(withoutSource, toLeafId, edge, ref);
}

function appendToFirstLeaf(node: LayoutNode, ref: TabRef): LayoutNode {
  const first = allLeaves(node)[0];
  if (!first) return makeLeaf([ref]);
  return transformLeaf(node, first.id, (leaf) => insertInLeaf(leaf, ref));
}

/** Move a tab to `toLeafId` at `index` (strip reorder within/between leaves — no split). */
export function moveTab(
  tree: LayoutNode,
  ref: TabRef,
  fromLeafId: string,
  toLeafId: string,
  index?: number,
): LayoutNode {
  return dropTab(tree, { ref, fromLeafId, toLeafId, edge: 'center', index });
}

/** Close the tab `key` from leaf `leafId` (activating its neighbour); drops the leaf if it empties. */
export function closeTab(tree: LayoutNode, leafId: string, key: string): LayoutNode {
  const next = transformLeaf(tree, leafId, (leaf) => {
    if (!leaf.tabs.some((t) => tabRefKey(t) === key)) return leaf;
    return {
      ...leaf,
      tabs: leaf.tabs.filter((t) => tabRefKey(t) !== key),
      activeKey: leaf.activeKey === key ? neighbourKey(leaf, key) : leaf.activeKey,
    };
  });
  return normalise(next);
}

/**
 * Add `ref` to leaf `leafId` and activate it — appending if absent, else just
 * focusing it (add-or-focus, no duplicate within a leaf). Used to open a file
 * or terminal into a specific pane PERMANENTLY: if `ref` was this leaf's preview
 * tab, opening it permanently promotes it (clears `previewKey`).
 */
export function addTabToLeaf(tree: LayoutNode, leafId: string, ref: TabRef): LayoutNode {
  const key = tabRefKey(ref);
  const next = transformLeaf(tree, leafId, (leaf) => {
    const previewKey = leaf.previewKey === key ? null : leaf.previewKey;
    if (leaf.tabs.some((t) => sameRef(t, ref))) return { ...leaf, activeKey: key, previewKey };
    return { ...leaf, tabs: [...leaf.tabs, ref], activeKey: key, previewKey };
  });
  return normalise(next);
}

/**
 * Open `ref` as leaf `leafId`'s ephemeral PREVIEW tab (VSCode single-click). If
 * `ref` is already open it is just focused (its permanent/preview state stays);
 * otherwise it replaces the leaf's current preview tab IN PLACE — so a run of
 * single-clicks reuses one slot — and becomes the new preview + active tab.
 *
 * Exception: a preview TERMINAL is a live PTY, so it is never silently discarded
 * — instead it is PINNED (promoted) and the new tab opens alongside it. That
 * keeps an agent terminal you were watching from vanishing when you peek at a
 * file, and avoids the dead-end where re-clicking that session (same URL) would
 * not re-open a tab the effect never re-runs for.
 */
export function openPreview(tree: LayoutNode, leafId: string, ref: TabRef): LayoutNode {
  const key = tabRefKey(ref);
  const next = transformLeaf(tree, leafId, (leaf) => {
    if (leaf.tabs.some((t) => sameRef(t, ref))) return { ...leaf, activeKey: key };
    const idx = leaf.previewKey ? leaf.tabs.findIndex((t) => tabRefKey(t) === leaf.previewKey) : -1;
    const replaceInPlace = idx >= 0 && !isTerminal(leaf.tabs[idx]!);
    const tabs = replaceInPlace
      ? leaf.tabs.map((t, i) => (i === idx ? ref : t))
      : [...leaf.tabs, ref];
    return { ...leaf, tabs, activeKey: key, previewKey: key };
  });
  return normalise(next);
}

/** Promote the tab `key` wherever it is the preview tab, making it permanent (double-click). */
export function promoteTab(tree: LayoutNode, key: string): LayoutNode {
  const walk = (node: LayoutNode): LayoutNode =>
    node.kind === 'leaf'
      ? node.previewKey === key
        ? { ...node, previewKey: null }
        : node
      : { ...node, children: node.children.map(walk) };
  return walk(tree);
}

/** Set the active tab of a leaf. */
export function focusTab(tree: LayoutNode, leafId: string, key: string): LayoutNode {
  return transformLeaf(tree, leafId, (leaf) =>
    leaf.tabs.some((t) => tabRefKey(t) === key) ? { ...leaf, activeKey: key } : leaf,
  ) as LayoutNode;
}

/** Persist a split's child sizes (from a Group's onLayoutChanged). */
export function resizeSplit(tree: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  function walk(node: LayoutNode): LayoutNode {
    if (node.kind === 'leaf') return node;
    if (node.id === splitId && sizes.length === node.children.length) {
      return { ...node, children: node.children.map(walk), sizes: [...sizes] };
    }
    return { ...node, children: node.children.map(walk) };
  }
  return walk(tree);
}

/** Drop every tab for which `keep` is false (e.g. a dead session); collapses emptied leaves. */
export function pruneTabs(tree: LayoutNode, keep: (ref: TabRef) => boolean): LayoutNode {
  const walk = (node: LayoutNode): LayoutNode =>
    node.kind === 'leaf'
      ? { ...node, tabs: node.tabs.filter(keep) }
      : { ...node, children: node.children.map(walk) };
  return normalise(walk(tree));
}

// ---- Migration from the legacy flat snapshot ------------------------------

/**
 * Build a tree equivalent to today's fixed layout from a legacy snapshot (when
 * `layout_tree` is null): the editor tabs above the terminal tabs in a column,
 * seeded from the flat `layout` sizes when present. Empty editor or terminal
 * sides collapse away, so a terminal-only workspace is a single leaf — matching
 * "no editor tab ⇒ terminals take the full height".
 */
export function buildInitialTree(snapshot: UiStateSnapshot): LayoutNode {
  const editorRefs: TabRef[] = snapshot.editor_tabs.map((tab) => ({ type: 'editor', tab }));
  const termRefs: TabRef[] = snapshot.session_tabs.map((session) => ({
    type: 'terminal',
    session,
  }));

  const activeEditorKey = snapshot.active_editor_tab
    ? tabRefKey({ type: 'editor', tab: snapshot.active_editor_tab })
    : null;
  const activeTermKey = snapshot.active_session ? `term:${snapshot.active_session}` : null;

  if (editorRefs.length === 0 && termRefs.length === 0) return makeLeaf([]);
  if (editorRefs.length === 0) return makeLeaf(termRefs, activeTermKey);
  if (termRefs.length === 0) return makeLeaf(editorRefs, activeEditorKey);

  const layout = snapshot.layout as Record<string, unknown>;
  const editorSize = typeof layout['editor'] === 'number' ? layout['editor'] : 40;
  const sessionSize = typeof layout['session'] === 'number' ? layout['session'] : 60;
  return normalise(
    makeSplit(
      'col',
      [makeLeaf(editorRefs, activeEditorKey), makeLeaf(termRefs, activeTermKey)],
      [editorSize, sessionSize],
    ),
  );
}
