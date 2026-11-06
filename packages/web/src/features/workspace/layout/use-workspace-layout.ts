import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, SavedLayout, Session } from '@puddle/shared';
import { clientSettings, updateClientSettings } from '../../../lib/settings/client-settings';
import { warmEditorChunk } from '../../editor/lazy-editor-parts';
import { warmTerminalChunk } from '../../terminal/LazyTerminal';
import { setLayoutBridge } from '../../layouts/layouts-store';
import type { UiStateHandle } from '../use-ui-state';
import { useLayoutTree } from './useLayoutTree';
import { boundToLiveSession, findLeaf, flattenTabs, pruneTabs } from './layout-tree';
import {
  loadLayoutPatch,
  mergeShardedLayouts,
  parkedTerminalSessions,
  scopeUiState,
  splitToProjects,
  unionToProfile,
} from './project-layout';
import { layoutSignature } from './layout-signature';

/** Own scope transitions, saved-layout restoration and focus over the persisted working set. */
export function useWorkspaceLayout(
  baseUiState: UiStateHandle,
  {
    projectId,
    projectMode,
    sessions,
    projects,
    orderedProjects,
  }: {
    projectId: string;
    projectMode: boolean;
    sessions: Session[] | undefined;
    projects: Project[] | undefined;
    orderedProjects: Project[];
  },
) {
  const projectScoped = projectMode && baseUiState.snapshot.layout_mode === 'project';
  const uiState = scopeUiState(baseUiState, projectId, projectScoped);
  const baseUiStateRef = useRef(baseUiState);
  baseUiStateRef.current = baseUiState;
  const allSessionsRef = useRef(sessions);
  allSessionsRef.current = sessions;
  // One-shot layout-mode transitions (SPEC §11): when the client's
  // project-based layout setting disagrees with the mode the snapshot was last
  // maintained in, convert it — split the shared tree into per-project slices
  // on the way in, union the slices back on the way out — and stamp
  // `layout_mode`, so a snapshot converts exactly once even when the setting
  // flipped while no workspace was open (or in another browser).
  const orderedProjectsRef = useRef(orderedProjects);
  orderedProjectsRef.current = orderedProjects;
  const profileProjectsRef = useRef(projects);
  profileProjectsRef.current = projects;
  useEffect(() => {
    const base = baseUiStateRef.current;
    if (!base.loaded) return;
    const snap = base.current();
    const mode = snap.layout_mode ?? 'profile';
    if (projectMode && mode !== 'project') {
      // The split needs the session → project map and the full project list
      // (archived projects included — their sessions' tabs must land
      // somewhere); wait until both have arrived.
      if (!sessions || !projects) return;
      const sessionProject = new Map(sessions.map((s) => [s.id, s.project_id]));
      const patch = splitToProjects(
        snap,
        projects.map((p) => p.id),
        sessionProject,
        projectId,
      );
      base.update({
        ...patch,
        // Slices preserved through an earlier profile-layout load beat their
        // shard: flipping the setting must never erase stored per-project
        // layouts (SPEC §11).
        project_layouts: mergeShardedLayouts(patch.project_layouts ?? {}, snap.project_layouts),
      });
    } else if (!projectMode && mode === 'project') {
      // Union order: the current project's slice leads, the rest follow the
      // sidebar's project order.
      base.update(
        unionToProfile(snap, [projectId, ...orderedProjectsRef.current.map((p) => p.id)]),
      );
    }
  }, [projectMode, baseUiState.loaded, sessions, projects, projectId]);

  // WHICH tree is live: the profile-wide surface, or this project's slice. It
  // keys the layout controller's migration cache and the closed-tab stack alike
  // — a reopen must land in the tree the tab was closed from.
  const scopeKey = projectScoped ? `project:${projectId}` : 'profile';
  const layout = useLayoutTree(uiState, scopeKey);
  // Locked-preview scrolling owns a separate transient focus from the pane
  // focus that routes opens, tab hotkeys, sidebar binding, and saves. A wheel
  // gesture may move this owner without making the scrolled pane the next-open
  // destination (decision 2026-08-13).
  const [scrollDriverOwner, setScrollDriverOwner] = useState<{
    scopeKey: string;
    leafId: string;
  } | null>(null);
  const claimScrollDriver = useCallback(
    (leafId: string) => setScrollDriverOwner({ scopeKey, leafId }),
    [scopeKey],
  );
  const ownedScrollLeaf =
    scrollDriverOwner?.scopeKey === scopeKey
      ? findLeaf(layout.tree, scrollDriverOwner.leafId)
      : null;
  const scrollDriverLeafId = ownedScrollLeaf?.id ?? layout.focusedLeaf.id;
  // A real logical activation starts a fresh scroll-driving context. The deps
  // stay unchanged when only `scrollDriverOwner` moves, so wheel input does not
  // immediately snap ownership back to the logically focused pane.
  useEffect(() => {
    claimScrollDriver(layout.focusedLeaf.id);
  }, [claimScrollDriver, layout.focusedLeaf.id, layout.focusedLeaf.activeKey]);
  const focusLeaf = useCallback(
    (leafId: string) => {
      layout.focusLeaf(leafId);
      claimScrollDriver(leafId);
    },
    [layout, claimScrollDriver],
  );
  // The terminals the OTHER projects' layouts hold open. Only under
  // project-based layout: the profile-wide tree already contains every tab, so
  // there is nothing outside it to keep alive (and a preserved slice's tabs are
  // not open in that mode). Keeping them mounted is what makes a project switch
  // park terminals rather than rebuild them (SPEC §11).
  const projectSlices = baseUiState.snapshot.project_layouts;
  const parkedSessions = useMemo(
    () => (projectScoped ? parkedTerminalSessions(projectSlices, projectId) : []),
    [projectScoped, projectSlices, projectId],
  );
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const uiStateRef = useRef(uiState);
  uiStateRef.current = uiState;
  // Reload must not suspend mid-restore: mounting the restored tree while the
  // Monaco/xterm chunks are still cold suspended EVERY pane into its fallback
  // ("Loading editor…" / a blank terminal) — and the reveal only reached the
  // screen on the next render (a tab click). Warm exactly the chunks the
  // restored tabs need behind the existing loading gate; once warm, the lazy
  // wrappers render their components directly, with no Suspense pass at all.
  // A terminal-only workspace still loads no Monaco (SPEC §8); an empty one
  // warms nothing. A failed import degrades to the old lazy path
  // rather than wedging the workspace. This gates the FIRST open only — a later
  // project switch keeps the workspace mounted (and its warmed chunks), and
  // must not re-blank it to wait on a chunk the new tree may not even need. It
  // still re-runs per scope, so the tree a switch brings up warms what it needs
  // as early as possible — just without holding the render back.
  const [chunksReady, setChunksReady] = useState(false);
  useEffect(() => {
    if (!uiState.loaded) return;
    let active = true;
    const tabs = flattenTabs(layoutRef.current.tree);
    const ready = () => {
      if (active) setChunksReady(true);
    };
    void Promise.all([
      tabs.some((t) => t.type === 'terminal') ? warmTerminalChunk() : undefined,
      tabs.some((t) => t.type === 'editor') ? warmEditorChunk() : undefined,
    ]).then(ready, ready);
    return () => {
      active = false;
    };
  }, [uiState.loaded, scopeKey]);

  // Prune dead tabs (and dead session_order ids) once per mount, whenever the
  // FULL session list first arrives — decoupled from `restored` so a slow or
  // transiently failing fetch neither blocks the workspace nor forfeits the
  // prune for the window's lifetime. The alive set must span EVERY session on
  // the daemon: the profile-keyed tree holds cross-project tabs, and pruning
  // against one project's list would wipe the rest.
  const pruned = useRef(false);
  useEffect(() => {
    if (pruned.current || !uiState.loaded || !sessions) return;
    pruned.current = true;
    const alive = new Set(sessions.filter((s) => s.status !== 'archived').map((s) => s.id));
    layoutRef.current.pruneSessions(alive);
    // Project-based slices hold trees the visible prune above never touches
    // (it sees only the scoped tree) — prune every stored slice the same way.
    // Read through current(): the visible prune has already written this tick.
    const base = baseUiStateRef.current;
    const record = base.current().project_layouts;
    if (Object.keys(record).length > 0) {
      const keep = boundToLiveSession(alive);
      base.update({
        project_layouts: Object.fromEntries(
          Object.entries(record).map(([pid, slice]) => [
            pid,
            {
              ...slice,
              layout_tree: slice.layout_tree ? pruneTabs(slice.layout_tree, keep) : null,
              active_session:
                slice.active_session !== null && alive.has(slice.active_session)
                  ? slice.active_session
                  : null,
            },
          ]),
        ),
      });
    }
    const order = uiStateRef.current.snapshot.session_order;
    const liveOrder = order.filter((id) => alive.has(id));
    if (liveOrder.length !== order.length) {
      uiStateRef.current.update({ session_order: liveOrder });
    }
  }, [uiState.loaded, sessions]);

  // Load a saved layout (SPEC §11): `loadLayoutPatch` is the whole
  // transformation — the patch is applied BEFORE the setting flips, so the
  // one-shot transition effect above finds nothing to convert and the default
  // union/shard cannot overwrite the layout being loaded.
  const applyLayout = useCallback(
    (saved: SavedLayout): boolean => {
      const base = baseUiStateRef.current;
      const live = allSessionsRef.current;
      const projects = profileProjectsRef.current;
      if (!base.loaded || !live || !projects) return false;
      const { patch, projectBased } = loadLayoutPatch(base.current(), saved, {
        alive: new Set(live.filter((s) => s.status !== 'archived').map((s) => s.id)),
        sessionProject: new Map(live.map((s) => [s.id, s.project_id])),
        projectIds: projects.map((p) => p.id),
        currentProject: projectId,
      });
      base.update(patch);
      if (clientSettings().projectBasedLayout !== projectBased) {
        updateClientSettings({ projectBasedLayout: projectBased });
      }
      return true;
    },
    [projectId],
  );

  // The top-bar Layouts popover reads the live layout — and loads saved ones —
  // through this bridge while a workspace is mounted (layouts-store). The
  // scoped snapshot keeps `layout_ref`/`layout_tree` pointing at whichever
  // slice is live, so the bridge is mode-agnostic.
  const savedScope = projectScoped ? 'project' : 'profile';
  const scopedTree = uiState.snapshot.layout_tree;
  const scopedLayoutRef = uiState.snapshot.layout_ref;
  const projectLayouts = baseUiState.snapshot.project_layouts;
  useEffect(() => {
    if (!baseUiState.loaded) return;
    setLayoutBridge({
      scope: savedScope,
      projectId,
      layoutRef: scopedLayoutRef,
      signature: layoutSignature(scopedTree),
      // Every stored slice, not just this project's: other projects' current
      // layouts (project mode) or slices preserved through a profile-load —
      // a cross-project load replaces one of THESE, and the popover confirms
      // against exactly what it replaces.
      slices: Object.fromEntries(
        Object.entries(projectLayouts).map(([pid, slice]) => [
          pid,
          { layoutRef: slice.layout_ref, signature: layoutSignature(slice.layout_tree) },
        ]),
      ),
      capture: () => {
        const cur = uiStateRef.current.current();
        return { layout_tree: cur.layout_tree, active_session: cur.active_session };
      },
      apply: applyLayout,
    });
  }, [
    baseUiState.loaded,
    savedScope,
    projectId,
    scopedTree,
    scopedLayoutRef,
    projectLayouts,
    applyLayout,
  ]);
  useEffect(() => () => setLayoutBridge(null), []);

  return {
    uiState,
    projectScoped,
    scopeKey,
    layout,
    parkedSessions,
    chunksReady,
    focusLeaf,
    claimScrollDriver,
    scrollDriverLeafId,
  };
}
