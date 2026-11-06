import type { LayoutNode } from '@puddle/shared';
import type { UiStateHandle } from '../use-ui-state';

/** Apply a file/draft identity change to every retained tree using the latest snapshot. */
export function updateWorkspaceTrees(
  base: UiStateHandle,
  transform: (tree: LayoutNode) => LayoutNode,
): void {
  const snapshot = base.current();
  const tree = snapshot.layout_tree;
  const next = tree ? transform(tree) : tree;
  let changed = next !== tree;
  const slices = Object.fromEntries(
    Object.entries(snapshot.project_layouts).map(([id, slice]) => {
      const updated = slice.layout_tree ? transform(slice.layout_tree) : null;
      if (updated === slice.layout_tree) return [id, slice];
      changed = true;
      return [id, { ...slice, layout_tree: updated }];
    }),
  );
  if (changed) base.update({ layout_tree: next, project_layouts: slices });
}
