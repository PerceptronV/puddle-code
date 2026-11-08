import {
  savedWindowLayoutSchema,
  windowArrangementSchema,
  windowArrangementScopeError,
  type DesktopWindowIdentity,
  type LayoutScope,
  type UiStateSnapshot,
  type WindowLayoutSlice,
} from '@puddle/shared';
import {
  buildInitialTree,
  flattenTabs,
  makeSplit,
  normalise,
  dedupeIds,
  pruneTabs,
} from '../../workspace/layout/layout-tree';
import { detachProjectContent } from '../transfers/content/project-content';

/** The coordinator supplies checkpointed participants from one host and profile. */
export interface ArrangementSource {
  identity: DesktopWindowIdentity;
  snapshot: UiStateSnapshot;
  visibleProject: string | null;
}

const slice = (snapshot: WindowLayoutSlice): WindowLayoutSlice => ({
  layout_tree: snapshot.layout_tree,
  active_session: snapshot.active_session,
});

/** Capture logical slots; native bounds, drafts and view caches never enter a saved layout. */
export function captureWindowArrangement(
  sources: ArrangementSource[],
  scope: LayoutScope,
  projectId: string | null,
  sessionProjects: ReadonlyMap<string, string>,
) {
  if (scope === 'project' && !projectId)
    throw new Error('Select a project before saving its windows');
  const windows = sources.flatMap(({ identity, snapshot, visibleProject }) => {
    if (scope === 'project' && identity.kind !== 'host' && identity.projectId !== projectId)
      return [];
    let content = snapshot;
    if (scope === 'project' && identity.kind === 'host') {
      const selected = detachProjectContent(
        { snapshot, buffers: [], views: {} },
        projectId!,
        sessionProjects,
        visibleProject ?? '',
      ).destination.snapshot;
      // Loading this host descriptor will replace only the selected slice.
      content = {
        ...snapshot,
        layout_mode: 'project',
        layout_tree: null,
        active_session: null,
        project_layouts: { [projectId!]: { ...slice(selected), layout_ref: null } },
      };
    }
    const tree =
      content.layout_mode === 'project'
        ? content.layout_tree
        : (content.layout_tree ?? buildInitialTree(content));
    return [
      savedWindowLayoutSchema.parse({
        key:
          identity.kind === 'host'
            ? 'host'
            : identity.kind === 'project'
              ? `project-${identity.projectId}`
              : identity.id,
        kind: identity.kind,
        project_id:
          identity.kind === 'host'
            ? scope === 'project'
              ? projectId
              : visibleProject
            : identity.projectId,
        layout_mode: content.layout_mode ?? 'profile',
        layout_tree: tree,
        active_session: content.active_session,
        project_layouts: Object.fromEntries(
          Object.entries(content.project_layouts).map(([id, value]) => [id, slice(value)]),
        ),
      }),
    ];
  });
  const arrangement = windowArrangementSchema.parse({ version: 1, windows });
  const scopeError = windowArrangementScopeError(arrangement, scope, projectId);
  if (scopeError) throw new Error(scopeError);
  // Browsers and older shells load a complete single-window fallback. Preserve
  // independent editor views; a terminal has one viewer within that window.
  const seen = new Set<string>();
  const trees = windows
    .flatMap((window) =>
      window.layout_mode === 'project'
        ? Object.values(window.project_layouts).map((value) => value.layout_tree)
        : [window.layout_tree],
    )
    .filter((tree) => tree !== null)
    .map((tree) =>
      pruneTabs(tree, (tab) => {
        if (tab.type === 'editor') return true;
        if (seen.has(tab.session)) return false;
        seen.add(tab.session);
        return true;
      }),
    )
    .filter((tree) => flattenTabs(tree).length !== 0);
  return {
    window_arrangement: arrangement,
    layout_tree: trees.length
      ? dedupeIds(normalise(trees.length === 1 ? trees[0]! : makeSplit('row', trees)))
      : null,
    active_session:
      windows
        .flatMap((window) =>
          window.layout_mode === 'project'
            ? Object.values(window.project_layouts).map((value) => value.active_session)
            : [window.active_session],
        )
        .find((session) => session !== null && seen.has(session)) ?? null,
  };
}
