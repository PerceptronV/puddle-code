import type { DesktopWorkspaceContent, LayoutNode, UiStateSnapshot, TabRef } from '@puddle/shared';
import { desktopTabKey } from '@puddle/shared';
import {
  findLeaf,
  flattenTabs,
  makeLeaf,
  normalise,
  tabRefKey,
  allLeaves,
  closeTab,
} from '../../../workspace/layout/layout-tree';
import { scopedSnapshot } from '../../../workspace/layout/project-layout';
import { windowBufferKey } from '../../state/content-state';
import { transferPaneViews } from './transfer-views';

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
  return partitionWindowContent(content, source, destination, projectId);
}

/** Move the clicked view when present, or open an unopened file/session in a new pane. */
export function detachTabContent(
  content: DesktopWorkspaceContent,
  projectId: string,
  ref: TabRef,
  paneId?: string,
): { source: DesktopWorkspaceContent; destination: DesktopWorkspaceContent } {
  const base = content.snapshot;
  const key = tabRefKey(ref);
  const identity = desktopTabKey(ref);
  const scopes =
    base.layout_mode === 'project'
      ? [projectId, ...Object.keys(base.project_layouts).filter((id) => id !== projectId)].map(
          (id) => ({ id, snapshot: scopedSnapshot(base, id) }),
        )
      : [{ id: projectId, snapshot: base }];
  const match = scopes
    .flatMap((scope) =>
      (scope.snapshot.layout_tree ? allLeaves(scope.snapshot.layout_tree) : [])
        .filter(
          (leaf) =>
            (!paneId || paneId === leaf.id) &&
            leaf.tabs.some((tab) => desktopTabKey(tab) === identity),
        )
        .map((leaf) => ({ scope, leaf })),
    )
    .at(0);
  if (paneId && !match) throw new Error('The tab has changed; try opening it again');
  const actual = match?.leaf.tabs.find((tab) => desktopTabKey(tab) === identity) ?? ref;
  const pane = makeLeaf([actual]);
  // View-state keys are pane-local. The two renderers may temporarily share a
  // pane id; docking reassigns colliding ids when joining their trees.
  if (match) pane.id = match.leaf.id;
  let source = base;
  if (match) {
    const remaining = closeTab(match.scope.snapshot.layout_tree!, match.leaf.id, key);
    const active = match.scope.snapshot.active_session;
    const active_session =
      active &&
      flattenTabs(remaining).some((tab) => tab.type === 'terminal' && tab.session === active)
        ? active
        : null;
    source =
      base.layout_mode === 'project'
        ? {
            ...base,
            project_layouts: {
              ...base.project_layouts,
              [match.scope.id]: {
                ...base.project_layouts[match.scope.id]!,
                layout_tree: remaining,
                active_session,
              },
            },
          }
        : { ...base, layout_tree: remaining, active_session };
  }
  const scoped = base.layout_mode === 'project' ? scopedSnapshot(base, projectId) : base;
  const destination: UiStateSnapshot = {
    ...scoped,
    layout_mode: 'profile',
    project_layouts: {},
    layout_tree: pane,
    session_tabs: [],
    editor_tabs: [],
    active_editor_tab: null,
    layout_ref: null,
    active_session: actual.type === 'terminal' ? actual.session : null,
  };
  return partitionWindowContent(content, source, destination, match?.scope.id ?? projectId);
}

export function partitionWindowContent(
  content: DesktopWorkspaceContent,
  source: UiStateSnapshot,
  destination: UiStateSnapshot,
  sourceProjectId: string,
) {
  const moved = bufferKeys(destination.layout_tree);
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
      views: {
        ...content.views,
        ...transferPaneViews(
          content.views,
          new Map(allLeaves(destination.layout_tree!).map((pane) => [pane.id, pane.id])),
          content.snapshot.layout_mode === 'project' ? `project:${sourceProjectId}` : 'profile',
          'profile',
        ),
      },
    },
  };
}
