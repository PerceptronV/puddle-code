import type { DesktopWorkspaceContent, LayoutNode, UiStateSnapshot } from '@puddle/shared';
import {
  allLeaves,
  attachPane,
  buildInitialTree,
  findLeaf,
  flattenTabs,
  pruneTabs,
  type DropEdge,
} from '../workspace/layout/layout-tree';
import { scopedSnapshot } from '../workspace/layout/project-layout';
import { windowBufferKey } from './content-state';
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
  const pane = incoming.snapshot.layout_tree;
  if (
    pane?.kind !== 'leaf' ||
    incoming.snapshot.layout_mode === 'project' ||
    Object.keys(incoming.snapshot.project_layouts).length !== 0
  )
    throw new Error('Only an isolated pane can be docked');

  const buffers = new Map(destination.buffers.map((buffer) => [windowBufferKey(buffer), buffer]));
  for (const buffer of incoming.buffers) {
    const key = windowBufferKey(buffer);
    const previous = buffers.get(key);
    if (
      previous &&
      (previous.content !== buffer.content || previous.baseMtimeMs !== buffer.baseMtimeMs)
    )
      throw new Error(`Both windows have different unsaved edits to ${buffer.path}`);
    buffers.set(key, buffer);
  }

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
  let id = pane.id;
  while (ids.has(id)) id = crypto.randomUUID();
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
    attachPane(tree, inserted, targetId, placement?.edge ?? 'right'),
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
    buffers: [...buffers.values()],
    views: {
      ...destination.views,
      ...transferPaneViews(
        incoming.views,
        new Map([[pane.id, id]]),
        'profile',
        base.layout_mode === 'project' ? `project:${projectId}` : 'profile',
      ),
    },
  };
}
