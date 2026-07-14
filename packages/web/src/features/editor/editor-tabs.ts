/**
 * Pure tab-order logic for the editor zone (SPEC §8). A tab is a
 * `(session, path)` pair — the same key the buffer store and drafts use. This
 * module is deliberately monaco-free (no `buffer-store.ts` import) so it is
 * unit-testable under vitest and safe to reach from eager code: the
 * Workspace-level `openFile` handler adds/focuses a tab here without pulling
 * the lazy editor chunk in.
 */

export interface EditorTab {
  session: string;
  path: string;
}

export function sameTab(a: EditorTab, b: EditorTab): boolean {
  return a.session === b.session && a.path === b.path;
}

export function hasTab(tabs: readonly EditorTab[], tab: EditorTab): boolean {
  return tabs.some((t) => sameTab(t, tab));
}

/** Appends `tab` if it is not already open; otherwise returns `tabs` unchanged (focus, don't duplicate). */
export function addOrFocusTab(tabs: readonly EditorTab[], tab: EditorTab): EditorTab[] {
  return hasTab(tabs, tab) ? [...tabs] : [...tabs, tab];
}

export function removeTab(tabs: readonly EditorTab[], tab: EditorTab): EditorTab[] {
  return tabs.filter((t) => !sameTab(t, tab));
}

/**
 * Which tab should be active once `closing` is removed, given the current
 * `active` tab. Closing an inactive tab keeps `active`; closing the active tab
 * lands on its right neighbour, else its left neighbour, else null (last tab).
 */
export function activeAfterClose(
  tabs: readonly EditorTab[],
  closing: EditorTab,
  active: EditorTab | null,
): EditorTab | null {
  if (!active || !sameTab(active, closing)) return active;
  const idx = tabs.findIndex((t) => sameTab(t, closing));
  if (idx === -1) return active;
  const remaining = removeTab(tabs, closing);
  if (remaining.length === 0) return null;
  return remaining[Math.min(idx, remaining.length - 1)] ?? null;
}

/** Moves `dragged` to sit immediately before `before` (HTML5 drag reorder). */
export function reorderTabs(
  tabs: readonly EditorTab[],
  dragged: EditorTab,
  before: EditorTab,
): EditorTab[] {
  if (sameTab(dragged, before)) return [...tabs];
  const next = removeTab(tabs, dragged);
  const at = next.findIndex((t) => sameTab(t, before));
  if (at === -1) return [...tabs];
  next.splice(at, 0, dragged);
  return next;
}
