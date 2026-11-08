import type { EditorTabRef, LayoutNode, UiStateSnapshot } from '@puddle/shared';

type FileIdentity = Pick<EditorTabRef, 'session' | 'path' | 'root'>;

/** Count logical views, including inactive tabs; mounted Monaco holders are not tab ownership. */
export function fileViewCount(snapshot: UiStateSnapshot, file: FileIdentity): number {
  const count = (tree: LayoutNode | null): number => {
    if (!tree) return 0;
    if (tree.kind === 'split') return tree.children.reduce((sum, child) => sum + count(child), 0);
    return tree.tabs.filter(
      (ref) =>
        ref.type === 'editor' &&
        ref.tab.kind !== 'commit' &&
        ref.tab.kind !== 'untitled' &&
        ref.tab.session === file.session &&
        ref.tab.path === file.path &&
        ref.tab.root === file.root,
    ).length;
  };
  return snapshot.layout_mode === 'project'
    ? Object.values(snapshot.project_layouts).reduce(
        (sum, slice) => sum + count(slice.layout_tree),
        0,
      )
    : count(snapshot.layout_tree);
}
