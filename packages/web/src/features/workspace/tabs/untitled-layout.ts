import { UNTITLED_SESSION, type LayoutNode, type TabRef } from '@puddle/shared';
import type { EditorTab } from '../../editor/tabs/editor-tabs';
import { tabRefKey, pruneTabs } from '../layout/layout-tree';

/** Replace every copy atomically, preserving pane position and focus. */
export function replaceUntitled(tree: LayoutNode, name: string, tab: EditorTab): LayoutNode {
  const key = untitledKey(name);
  if (tree.kind === 'split') {
    const children = tree.children.map((child) => replaceUntitled(child, name, tab));
    return children.every((child, i) => child === tree.children[i]) ? tree : { ...tree, children };
  }
  if (!tree.tabs.some((ref) => tabRefKey(ref) === key)) return tree;
  const replacement: TabRef = { type: 'editor', tab };
  return {
    ...tree,
    tabs: tree.tabs.map((ref) => (tabRefKey(ref) === key ? replacement : ref)),
    activeKey: tree.activeKey === key ? tabRefKey(replacement) : tree.activeKey,
    previewKey: tree.previewKey === key ? null : tree.previewKey,
  };
}

export function discardUntitled(tree: LayoutNode, name: string): LayoutNode {
  const key = untitledKey(name);
  return pruneTabs(tree, (ref) => tabRefKey(ref) !== key);
}

function untitledKey(name: string): string {
  return tabRefKey({
    type: 'editor',
    tab: { kind: 'untitled', session: UNTITLED_SESSION, path: name },
  });
}
