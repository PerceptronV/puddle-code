import type { DesktopWorkspaceContent, SavedWindowLayout, UiStateSnapshot } from '@puddle/shared';
import { desktopTabKey } from '@puddle/shared';
import {
  allLeaves,
  dedupeIds,
  flattenTabs,
  makeLeaf,
  makeSplit,
  normalise,
  tabRefKey,
} from '../../workspace/layout/layout-tree';
import { detachProjectContent } from '../transfers/content/project-content';
import { transferPaneViews } from '../transfers/content/transfer-views';

export function arrangementTrees(snapshot: UiStateSnapshot) {
  return snapshot.layout_mode === 'project'
    ? Object.entries(snapshot.project_layouts).map(([id, slice]) => ({
        scope: `project:${id}`,
        tree: slice.layout_tree,
      }))
    : [{ scope: 'profile', tree: snapshot.layout_tree }];
}

/** Replace structure only; chrome remains the destination's own live preference. */
export function savedWindowSnapshot(
  base: UiStateSnapshot,
  slot?: SavedWindowLayout,
  layoutRef?: number,
): UiStateSnapshot {
  return {
    ...base,
    layout_mode: slot?.layout_mode ?? 'profile',
    layout_tree: slot?.layout_tree ?? makeLeaf(),
    active_session: slot?.active_session ?? null,
    project_layouts: Object.fromEntries(
      Object.entries(slot?.project_layouts ?? {}).map(([id, slice]) => [
        id,
        { ...slice, layout_ref: null },
      ]),
    ),
    layout_ref: layoutRef ?? null,
    session_tabs: [],
    editor_tabs: [],
    active_editor_tab: null,
  };
}

/** Project saves replace one host slice without converting or overwriting unrelated projects. */
export function projectWindowSnapshot(
  base: UiStateSnapshot,
  slot: SavedWindowLayout | undefined,
  projectId: string,
  sessionProjects: ReadonlyMap<string, string>,
  visibleProject: string | undefined,
  layoutRef?: number,
): UiStateSnapshot {
  const slice = {
    ...(slot?.project_layouts[projectId] ?? { layout_tree: makeLeaf(), active_session: null }),
    layout_ref: layoutRef ?? null,
  };
  if (base.layout_mode === 'project')
    return {
      ...base,
      project_layouts: { ...base.project_layouts, [projectId]: slice },
    };
  const remaining = detachProjectContent(
    { snapshot: base, buffers: [], views: {} },
    projectId,
    sessionProjects,
    visibleProject ?? '',
  ).source.snapshot;
  const trees = [remaining.layout_tree, slice.layout_tree]
    .filter((tree) => tree !== null)
    .filter((tree) => flattenTabs(tree).length > 0);
  const layout_tree = trees.length
    ? dedupeIds(normalise(trees.length === 1 ? trees[0]! : makeSplit('row', trees)))
    : makeLeaf();
  return {
    ...base,
    layout_tree,
    active_session: slice.active_session ?? remaining.active_session,
    // Inactive project history cannot override the newly applied selected slice.
    project_layouts: { ...base.project_layouts, [projectId]: slice },
    session_tabs: [],
    editor_tabs: [],
    active_editor_tab: null,
  };
}

/** Carry positions through pane-id/scope changes; prefer the destination's own duplicate views. */
export function arrangementViews(
  destination: DesktopWorkspaceContent,
  sources: DesktopWorkspaceContent[],
) {
  const views = { ...destination.views };
  for (const source of sources)
    for (const from of arrangementTrees(source.snapshot)) {
      if (!from.tree) continue;
      for (const to of arrangementTrees(destination.snapshot)) {
        if (!to.tree) continue;
        for (const oldPane of allLeaves(from.tree))
          for (const newPane of allLeaves(to.tree)) {
            const keys = new Set(newPane.tabs.map(desktopTabKey));
            const moved = new Set(
              oldPane.tabs.filter((tab) => keys.has(desktopTabKey(tab))).map(tabRefKey),
            );
            if (moved.size)
              Object.assign(
                views,
                transferPaneViews(
                  source.views,
                  new Map([[oldPane.id, newPane.id]]),
                  from.scope,
                  to.scope,
                  moved,
                ),
              );
          }
      }
    }
  return views;
}
