import type { DesktopWorkspaceContent, LayoutNode, UiStateSnapshot } from '@puddle/shared';
import {
  findLeaf,
  flattenTabs,
  makeLeaf,
  normalise,
  tabRefKey,
} from '../workspace/layout/layout-tree';
import { scopedSnapshot } from '../workspace/layout/project-layout';
import { windowBufferKey } from './content-state';

function bufferKeys(tree: LayoutNode | null): Set<string> {
  return new Set(
    tree
      ? flattenTabs(tree).flatMap((ref) =>
          ref.type === 'editor' ? [windowBufferKey(ref.tab)] : [],
        )
      : [],
  );
}

function withoutPane(tree: LayoutNode, paneId: string): LayoutNode {
  if (tree.kind === 'leaf') return tree.id === paneId ? makeLeaf() : tree;
  return normalise({ ...tree, children: tree.children.map((child) => withoutPane(child, paneId)) });
}

/** Move exactly one pane; a mixed-project pane keeps all its tabs and its anchor project. */
export function detachPaneContent(
  content: DesktopWorkspaceContent,
  projectId: string,
  paneId: string,
): { source: DesktopWorkspaceContent; destination: DesktopWorkspaceContent } {
  const base = content.snapshot;
  const scoped = base.layout_mode === 'project' ? scopedSnapshot(base, projectId) : base;
  const tree = scoped.layout_tree;
  const pane = tree && findLeaf(tree, paneId);
  if (!tree || !pane) throw new Error('The pane has changed; try opening it again');
  const remaining = withoutPane(tree, paneId);
  const remainingSession =
    scoped.active_session &&
    flattenTabs(remaining).some(
      (ref) => ref.type === 'terminal' && ref.session === scoped.active_session,
    )
      ? scoped.active_session
      : null;
  const source: UiStateSnapshot =
    base.layout_mode === 'project'
      ? {
          ...base,
          project_layouts: {
            ...base.project_layouts,
            [projectId]: {
              ...base.project_layouts[projectId]!,
              layout_tree: remaining,
              active_session: remainingSession,
            },
          },
        }
      : { ...base, layout_tree: remaining, active_session: remainingSession };
  const active = pane.tabs.find((ref) => tabRefKey(ref) === pane.activeKey);
  const destination: UiStateSnapshot = {
    ...scoped,
    layout_mode: 'profile',
    layout_tree: pane,
    project_layouts: {},
    session_tabs: [],
    editor_tabs: [],
    active_editor_tab: null,
    active_session: active?.type === 'terminal' ? active.session : null,
    layout_ref: null,
  };
  const moved = bufferKeys(pane);
  const retained = bufferKeys(source.layout_mode === 'project' ? null : source.layout_tree);
  if (source.layout_mode === 'project') {
    for (const slice of Object.values(source.project_layouts)) {
      for (const key of bufferKeys(slice.layout_tree)) retained.add(key);
    }
  }
  // Duplicate views in the source retain their own recoverable copy. Orphaned
  // recovery drafts stay with the source; unrelated drafts never enter a new pane.
  return {
    source: {
      snapshot: source,
      buffers: content.buffers.filter(
        (buffer) => !moved.has(windowBufferKey(buffer)) || retained.has(windowBufferKey(buffer)),
      ),
      views: content.views,
    },
    destination: {
      snapshot: destination,
      buffers: content.buffers.filter((buffer) => moved.has(windowBufferKey(buffer))),
      views: content.views,
    },
  };
}
