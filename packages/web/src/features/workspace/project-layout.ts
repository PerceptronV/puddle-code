import {
  UNTITLED_SESSION,
  type ProjectLayout,
  type TabRef,
  type UiStateSnapshot,
} from '@puddle/shared';
import { buildInitialTree, joinTrees, pruneTabs } from './layout-tree';
import type { UiStateHandle } from './use-ui-state';

/**
 * Project-based layout (SPEC §11): with the client setting on, the centre
 * editor persists one layout PER (profile, project) instead of one profile-wide
 * surface. The per-project slices live inside the same profile snapshot
 * (`project_layouts`, keyed by project id), so the two-tier persistence —
 * sessionStorage working set over the debounced profile row — carries them
 * unchanged. This module is the pure machinery: the scoped view of a snapshot,
 * the scoped handle Workspace swaps in, and the two one-shot transitions
 * (profile → project splits the shared tree; project → profile unions the
 * slices). DOM-free and unit-tested.
 */

const EMPTY_PROJECT_LAYOUT: ProjectLayout = { layout_tree: null, active_session: null };

/** The session a tab binds to (a terminal its own, an editor tab its worktree's). */
function tabSession(ref: TabRef): string {
  return ref.type === 'terminal' ? ref.session : ref.tab.session;
}

/**
 * The snapshot as project `projectId` sees it: the top-level layout keys are
 * replaced by that project's slice (absent slice → a fresh empty workspace).
 * The legacy flat fields describe the PROFILE-wide tree, so they are blanked —
 * a project with no slice yet must not rebuild the whole profile's tabs.
 */
export function scopedSnapshot(base: UiStateSnapshot, projectId: string): UiStateSnapshot {
  const slice = base.project_layouts[projectId];
  return {
    ...base,
    layout_tree: slice?.layout_tree ?? null,
    active_session: slice?.active_session ?? null,
    session_tabs: [],
    editor_tabs: [],
    active_editor_tab: null,
  };
}

/**
 * A UiStateHandle whose layout keys are scoped to one project: reads come from
 * `project_layouts[projectId]`, and updates touching `layout_tree` /
 * `active_session` are routed back into that slice (reading the LATEST record
 * through `current()`, so same-tick updates never clobber each other). Every
 * other key passes through untouched. Disabled, it is the base handle itself.
 */
export function scopeUiState(
  base: UiStateHandle,
  projectId: string,
  enabled: boolean,
): UiStateHandle {
  if (!enabled) return base;
  return {
    loaded: base.loaded,
    snapshot: scopedSnapshot(base.snapshot, projectId),
    current: () => scopedSnapshot(base.current(), projectId),
    update(patch) {
      const slice: Partial<ProjectLayout> = {};
      const rest: Partial<UiStateSnapshot> = { ...patch };
      if ('layout_tree' in patch) {
        slice.layout_tree = patch.layout_tree ?? null;
        delete rest.layout_tree;
      }
      if ('active_session' in patch) {
        slice.active_session = patch.active_session ?? null;
        delete rest.active_session;
      }
      if (Object.keys(slice).length > 0) {
        const record = base.current().project_layouts;
        rest.project_layouts = {
          ...record,
          [projectId]: { ...(record[projectId] ?? EMPTY_PROJECT_LAYOUT), ...slice },
        };
      }
      if (Object.keys(rest).length > 0) base.update(rest);
    },
  };
}

/**
 * The profile → project transition: split the profile-wide tree into one slice
 * per project, each keeping the shared tree's structure with only that
 * project's tabs (worktree-agnostic untitled drafts follow `untitledHome`, the
 * project open when the setting flipped). Returns the patch to apply to the
 * BASE snapshot; the top-level tree is left untouched — nothing reads it while
 * `layout_mode` is `project`, and the union overwrites it on the way back.
 */
export function splitToProjects(
  snap: UiStateSnapshot,
  projectIds: readonly string[],
  sessionProject: ReadonlyMap<string, string>,
  untitledHome: string | null,
): Partial<UiStateSnapshot> {
  const tree = snap.layout_tree ?? buildInitialTree(snap);
  const layouts: Record<string, ProjectLayout> = {};
  for (const pid of projectIds) {
    const pruned = pruneTabs(tree, (ref) => {
      const sid = tabSession(ref);
      if (sid === UNTITLED_SESSION) return pid === (untitledHome ?? projectIds[0]);
      return sessionProject.get(sid) === pid;
    });
    layouts[pid] = {
      layout_tree: pruned,
      active_session:
        snap.active_session !== null && sessionProject.get(snap.active_session) === pid
          ? snap.active_session
          : null,
    };
  }
  return { layout_mode: 'project', project_layouts: layouts };
}

/**
 * The project → profile transition: union every slice back into one tree
 * (structures side by side, tabs deduplicated — `joinTrees`), ordered with the
 * given project order first (the current project leads it) and any unlisted
 * slices after. The bound session is the first slice's, falling back through
 * the order. Clears the slices: each transition re-derives from scratch.
 */
export function unionToProfile(
  snap: UiStateSnapshot,
  orderedProjectIds: readonly string[],
): Partial<UiStateSnapshot> {
  const record = snap.project_layouts;
  const order = [
    ...orderedProjectIds.filter((id) => id in record),
    ...Object.keys(record).filter((id) => !orderedProjectIds.includes(id)),
  ];
  const slices = order.map((id) => record[id]!);
  return {
    layout_mode: 'profile',
    project_layouts: {},
    layout_tree: joinTrees(slices.map((s) => s.layout_tree).filter((t) => t !== null)),
    active_session: slices.map((s) => s.active_session).find((s) => s !== null) ?? null,
  };
}
