import type { DesktopProfileSeed, LayoutNode, UiStateSnapshot } from '@puddle/shared';
import { joinTrees } from '../workspace/layout/layout-tree';

/** Browser seeds contain the complete working set, flattened out of native windows. */
export function desktopProfileSeed(seed: DesktopProfileSeed): UiStateSnapshot {
  const snapshot = { ...seed.base, project_layouts: { ...seed.base.project_layouts } };
  const join = (a: LayoutNode | null, b: LayoutNode) => (a ? joinTrees([a, b]) : b);
  for (const { identity, snapshot: detached } of seed.detached) {
    if (identity.kind === 'host' || !detached.layout_tree) continue;
    if (snapshot.layout_mode === 'project') {
      const slice = snapshot.project_layouts[identity.projectId];
      snapshot.project_layouts[identity.projectId] = {
        layout_tree: join(slice?.layout_tree ?? null, detached.layout_tree),
        active_session: slice?.active_session ?? detached.active_session,
        layout_ref: slice?.layout_ref ?? null,
      };
    } else snapshot.layout_tree = join(snapshot.layout_tree, detached.layout_tree);
  }
  return snapshot;
}
