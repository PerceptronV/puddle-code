import {
  UNTITLED_SESSION,
  desktopTabKey,
  type DesktopWorkspaceContent,
  type LayoutNode,
  type TabRef,
  type UiStateSnapshot,
} from '@puddle/shared';
import {
  buildInitialTree,
  flattenTabs,
  makeLeaf,
  normalise,
  pruneTabs,
} from '../../../workspace/layout/layout-tree';
import { scopedSnapshot } from '../../../workspace/layout/project-layout';
import { partitionWindowContent } from './transfer-content';
import { mergeWindowBuffers } from './merge-buffers';
import { transferPaneViews } from './transfer-views';
import { retainLateDrafts } from '../../state/late-draft-recovery';

/** Project mode moves its complete tree; profile mode partitions mixed panes by tab ownership. */
export function detachProjectContent(
  content: DesktopWorkspaceContent,
  projectId: string,
  sessionProjects: ReadonlyMap<string, string>,
  untitledHome: string,
): { source: DesktopWorkspaceContent; destination: DesktopWorkspaceContent } {
  const base = content.snapshot;
  const scoped = base.layout_mode === 'project' ? scopedSnapshot(base, projectId) : base;
  const tree = scoped.layout_tree ?? buildInitialTree(scoped);
  const belongs = (ref: TabRef) => {
    const session = ref.type !== 'editor' ? ref.session : ref.tab.session;
    return session === UNTITLED_SESSION
      ? projectId === untitledHome
      : sessionProjects.get(session) === projectId;
  };
  const selected = base.layout_mode === 'project' ? tree : pruneTabs(tree, belongs);
  const moved = new Set(flattenTabs(selected).map(desktopTabKey));
  const historical = Object.fromEntries(
    Object.entries(base.project_layouts).map(([id, slice]) => [
      id,
      {
        ...slice,
        layout_tree: slice.layout_tree
          ? pruneTabs(slice.layout_tree, (ref) => !moved.has(desktopTabKey(ref)))
          : null,
        active_session:
          slice.active_session &&
          flattenTabs(selected).some(
            (ref) => ref.type !== 'editor' && ref.session === slice.active_session,
          )
            ? null
            : slice.active_session,
      },
    ]),
  );
  const remaining =
    base.layout_mode === 'project' ? makeLeaf() : pruneTabs(tree, (ref) => !belongs(ref));
  const hasSession = (node: LayoutNode, session: string | null) =>
    session !== null &&
    flattenTabs(node).some((ref) => ref.type !== 'editor' && ref.session === session);
  const source: UiStateSnapshot =
    base.layout_mode === 'project'
      ? {
          ...base,
          project_layouts: {
            ...base.project_layouts,
            [projectId]: { layout_tree: remaining, active_session: null, layout_ref: null },
          },
        }
      : {
          ...base,
          layout_tree: remaining,
          project_layouts: historical,
          active_session: hasSession(remaining, base.active_session) ? base.active_session : null,
        };
  const destination: UiStateSnapshot = {
    ...scoped,
    layout_tree: selected,
    layout_mode: 'profile',
    project_layouts: {},
    session_tabs: [],
    editor_tabs: [],
    active_editor_tab: null,
    active_session: hasSession(selected, scoped.active_session) ? scoped.active_session : null,
    layout_ref: base.layout_mode === 'project' ? scoped.layout_ref : null,
  };
  return partitionWindowContent(content, source, destination, projectId);
}

/** Restore a returned project alongside unrelated host work, including any late source drafts. */
export function returnProjectContent(
  destination: DesktopWorkspaceContent,
  incoming: DesktopWorkspaceContent,
  projectId: string,
): DesktopWorkspaceContent {
  if (incoming.snapshot.layout_mode !== 'profile' || !incoming.snapshot.layout_tree)
    throw new Error('The returned project has no isolated workspace');
  const buffers = mergeWindowBuffers(destination, incoming);
  const base = destination.snapshot;
  const scoped = base.layout_mode === 'project' ? scopedSnapshot(base, projectId) : base;
  const incomingTree = incoming.snapshot.layout_tree;
  const terminals = new Set(
    flattenTabs(incomingTree).flatMap((ref) => (ref.type === 'terminal' ? [ref.session] : [])),
  );
  const retain = (tree: LayoutNode) =>
    pruneTabs(tree, (ref) => ref.type !== 'terminal' || !terminals.has(ref.session));
  const remaining = retain(scoped.layout_tree ?? buildInitialTree(scoped));
  const reserved = new Set<string>();
  const collect = (tree: LayoutNode | null) => {
    if (!tree) return;
    reserved.add(tree.id);
    if (tree.kind === 'split') tree.children.forEach(collect);
  };
  collect(remaining);
  if (base.layout_mode === 'project')
    Object.values(base.project_layouts).forEach((slice) => collect(slice.layout_tree));
  const panes = new Map<string, string>();
  const rekey = (node: LayoutNode): LayoutNode => {
    let id = node.id;
    while (reserved.has(id)) id = crypto.randomUUID();
    reserved.add(id);
    if (node.kind === 'leaf') {
      panes.set(node.id, id);
      return { ...node, id };
    }
    return { ...node, id, children: node.children.map(rekey) };
  };
  const restored = rekey(incomingTree);
  const layout_tree = flattenTabs(remaining).length
    ? normalise({
        kind: 'split',
        id: crypto.randomUUID(),
        direction: 'row',
        children: [remaining, restored],
        sizes: [50, 50],
      })
    : restored;
  const incomingState = incoming.snapshot;
  let snapshot: UiStateSnapshot = {
    ...base,
    layout: incomingState.layout,
    explorer_pin: incomingState.explorer_pin,
    explorer_open: incomingState.explorer_open,
    sidebar_mode: incomingState.sidebar_mode,
    sidebar_collapsed: incomingState.sidebar_collapsed,
    sessions_collapsed: incomingState.sessions_collapsed,
    session_order: [...new Set([...incomingState.session_order, ...base.session_order])],
  };
  if (base.layout_mode === 'project') {
    const project_layouts = { ...base.project_layouts };
    for (const [id, slice] of Object.entries(project_layouts)) {
      if (id === projectId || !slice.layout_tree) continue;
      project_layouts[id] = {
        ...slice,
        layout_tree: retain(slice.layout_tree),
        active_session:
          slice.active_session && terminals.has(slice.active_session) ? null : slice.active_session,
      };
    }
    project_layouts[projectId] = {
      layout_tree,
      active_session: incomingState.active_session,
      layout_ref: incomingState.layout_ref,
    };
    snapshot = { ...snapshot, project_layouts };
  } else {
    // A retained historical slice must not override this project's latest
    // returned workspace on the next profile → project mode transition.
    const project_layouts = { ...base.project_layouts };
    delete project_layouts[projectId];
    for (const [id, slice] of Object.entries(project_layouts)) {
      if (!slice.layout_tree) continue;
      project_layouts[id] = {
        ...slice,
        layout_tree: retain(slice.layout_tree),
        active_session:
          slice.active_session && terminals.has(slice.active_session) ? null : slice.active_session,
      };
    }
    snapshot = {
      ...snapshot,
      layout_tree,
      project_layouts,
      active_session: incomingState.active_session,
    };
  }
  // A closed project can also hold recovery drafts without a mounted tab. Make
  // those visible on return, rather than retaining text only in a private store.
  snapshot = retainLateDrafts(snapshot, incoming.buffers, projectId);
  return {
    snapshot,
    buffers,
    views: {
      ...destination.views,
      ...transferPaneViews(
        incoming.views,
        panes,
        'profile',
        base.layout_mode === 'project' ? `project:${projectId}` : 'profile',
      ),
    },
  };
}
