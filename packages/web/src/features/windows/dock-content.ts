import type {
  DesktopWorkspaceContent,
  DesktopTabDock,
  LayoutNode,
  UiStateSnapshot,
} from '@puddle/shared';
import {
  allLeaves,
  attachPane,
  buildInitialTree,
  findLeaf,
  flattenTabs,
  pruneTabs,
  dropTab,
  tabRefKey,
  type DropEdge,
} from '../workspace/layout/layout-tree';
import { scopedSnapshot } from '../workspace/layout/project-layout';
import { mergeWindowBuffers } from './merge-buffers';
import { transferPaneViews } from './transfer-views';

/**
 * Compute the destination before either window changes ownership. Duplicate
 * editors remain separate views; one renderer can host only one live terminal
 * for each session, so its existing view follows the incoming pane.
 */
export function dockPaneContent(
  destination: DesktopWorkspaceContent,
  incoming: DesktopWorkspaceContent,
  projectId: string,
  placement?: { paneId: string; edge: Exclude<DropEdge, 'center'> },
): DesktopWorkspaceContent {
  return dockContent(destination, incoming, projectId, { kind: 'pane', placement });
}

export function dockTabContent(
  destination: DesktopWorkspaceContent,
  incoming: DesktopWorkspaceContent,
  projectId: string,
  placement: DesktopTabDock['placement'],
): DesktopWorkspaceContent {
  return dockContent(destination, incoming, projectId, { kind: 'tab', placement });
}

function dockContent(
  destination: DesktopWorkspaceContent,
  incoming: DesktopWorkspaceContent,
  projectId: string,
  move:
    | { kind: 'pane'; placement?: { paneId: string; edge: Exclude<DropEdge, 'center'> } }
    | { kind: 'tab'; placement: DesktopTabDock['placement'] },
): DesktopWorkspaceContent {
  const { placement } = move;
  const pane = incoming.snapshot.layout_tree;
  if (
    pane?.kind !== 'leaf' ||
    incoming.snapshot.layout_mode === 'project' ||
    Object.keys(incoming.snapshot.project_layouts).length !== 0
  )
    throw new Error('Only an isolated pane can be docked');
  if (move.kind === 'tab' && pane.tabs.length !== 1)
    throw new Error('A tab drop requires exactly one tab');

  const buffers = mergeWindowBuffers(destination, incoming);

  const base = destination.snapshot;
  const scoped = base.layout_mode === 'project' ? scopedSnapshot(base, projectId) : base;
  const tree = scoped.layout_tree ?? buildInitialTree(scoped);
  const targetId = placement?.paneId ?? allLeaves(tree).at(-1)!.id;
  if (!findLeaf(tree, targetId)) throw new Error('The destination pane has changed');

  // Copies can retain their original leaf id in different renderers. Reserve ids
  // across every live slice, including parked projects, before joining trees.
  const ids = new Set<string>();
  const collect = (node: LayoutNode | null) => {
    if (!node) return;
    ids.add(node.id);
    if (node.kind === 'split') node.children.forEach(collect);
  };
  collect(tree);
  if (base.layout_mode === 'project')
    for (const slice of Object.values(base.project_layouts)) collect(slice.layout_tree);
  const merge = move.kind === 'tab' && move.placement.edge === 'center';
  let id = merge ? targetId : pane.id;
  if (!merge) while (ids.has(id)) id = crypto.randomUUID();
  const inserted = { ...pane, id };
  const terminals = new Set(
    pane.tabs.flatMap((tab) => (tab.type === 'terminal' ? [tab.session] : [])),
  );
  const retain = (node: LayoutNode): LayoutNode =>
    pruneTabs(node, (tab) => tab.type !== 'terminal' || !terminals.has(tab.session));
  // Insert first: pruning an existing duplicate terminal could otherwise remove
  // the exact leaf under the drop and lose its requested placement.
  const removeExistingTerminals = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'leaf') return node.id === id ? node : retain(node);
    return { ...node, children: node.children.map(removeExistingTerminals) };
  };
  const joined = removeExistingTerminals(
    merge
      ? dropTab(tree, {
          ref: pane.tabs[0]!,
          fromLeafId: '',
          toLeafId: targetId,
          edge: 'center',
          index: move.placement?.index,
          copy: true,
        })
      : attachPane(
          tree,
          inserted,
          targetId,
          placement?.edge === 'center' ? 'right' : (placement?.edge ?? 'right'),
        ),
  );
  // Normalise without deduplicating editor views (joinTrees intentionally would).
  const layout_tree = pruneTabs(joined, () => true);
  const active_session =
    incoming.snapshot.active_session && terminals.has(incoming.snapshot.active_session)
      ? incoming.snapshot.active_session
      : null;
  let snapshot: UiStateSnapshot;
  if (base.layout_mode === 'project') {
    const project_layouts = { ...base.project_layouts };
    for (const [otherId, slice] of Object.entries(project_layouts)) {
      if (otherId === projectId || !slice.layout_tree) continue;
      if (
        !flattenTabs(slice.layout_tree).some(
          (tab) => tab.type === 'terminal' && terminals.has(tab.session),
        )
      )
        continue;
      project_layouts[otherId] = {
        ...slice,
        layout_tree: retain(slice.layout_tree),
        active_session:
          slice.active_session && terminals.has(slice.active_session) ? null : slice.active_session,
      };
    }
    project_layouts[projectId] = {
      ...(project_layouts[projectId] ?? { layout_ref: null }),
      layout_tree,
      active_session,
    };
    snapshot = { ...base, project_layouts };
  } else snapshot = { ...base, layout_tree, active_session };

  return {
    snapshot,
    buffers,
    views: {
      ...destination.views,
      ...transferPaneViews(
        incoming.views,
        new Map([[pane.id, id]]),
        'profile',
        base.layout_mode === 'project' ? `project:${projectId}` : 'profile',
        move.kind === 'tab' ? new Set(pane.tabs.map(tabRefKey)) : undefined,
      ),
    },
  };
}
