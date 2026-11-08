import {
  UNTITLED_SESSION,
  type DesktopBufferSnapshot,
  type TabRef,
  type UiStateSnapshot,
} from '@puddle/shared';
import { flattenTabs, joinTrees, makeLeaf } from '../../workspace/layout/layout-tree';
import { windowBufferKey } from './content-state';

/** Keep exceptional post-confirmation edits visible in their source window. */
export function retainLateDrafts(
  snapshot: UiStateSnapshot,
  buffers: DesktopBufferSnapshot[],
  projectId?: string,
): UiStateSnapshot {
  const scoped = snapshot.layout_mode === 'project' && projectId !== undefined;
  const tree = scoped ? snapshot.project_layouts[projectId]?.layout_tree : snapshot.layout_tree;
  const existing = new Set(
    (tree ? flattenTabs(tree) : []).flatMap((ref) =>
      ref.type === 'editor' ? [windowBufferKey(ref.tab)] : [],
    ),
  );
  const missing: TabRef[] = buffers
    .filter((buffer) => !existing.has(windowBufferKey(buffer)))
    .map((buffer) => ({
      type: 'editor',
      tab: {
        session: buffer.session,
        path: buffer.path,
        ...(buffer.root !== undefined ? { root: buffer.root } : {}),
        kind: buffer.session === UNTITLED_SESSION ? 'untitled' : 'file',
        view: 'source',
      },
    }));
  if (!missing.length) return snapshot;
  const recovery = makeLeaf(missing);
  const layout_tree = tree ? joinTrees([tree, recovery]) : recovery;
  return scoped
    ? {
        ...snapshot,
        project_layouts: {
          ...snapshot.project_layouts,
          [projectId]: {
            ...(snapshot.project_layouts[projectId] ?? { active_session: null, layout_ref: null }),
            layout_tree,
          },
        },
      }
    : { ...snapshot, layout_tree };
}
