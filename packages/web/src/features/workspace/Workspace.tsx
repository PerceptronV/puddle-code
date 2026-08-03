import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels';
import {
  UNTITLED_SESSION,
  type LayoutLeaf,
  type Session,
  type SessionKind,
  type TabRef,
} from '@puddle/shared';
import { createUntitled, deleteUntitled } from '../../lib/untitled-queries';
import { tabKind } from '../editor/editor-tabs';
import {
  forgetUntitledContent,
  setUntitledSaveHandler,
  type UntitledSaveRequest,
} from '../editor/untitled-save-store';
import { UntitledSaveDialog } from './UntitledSaveDialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { useExplorerTarget } from '../explorer/use-explorer-target';
import { useClientSettings } from '../../lib/client-settings';
import { useSessionTitleRenderer } from '../profile/use-session-title';
import {
  hostLabel,
  useAccounts,
  useAllSessions,
  useArchiveSession,
  useCreateSession,
  useDaemonVersion,
  useHostInfo,
  usePatchProfileSettings,
  useProfileSettings,
  useProjectDetail,
  useProjects,
} from '../../lib/queries';
import { mergeOrder, orderByDrag, reorderIds } from './session-order';
import { useNewSession } from '../shell/new-session-context';
import type { EditorTab } from '../editor/editor-tabs';
import {
  EditorProvider,
  useEditorHandler,
  type EditorPosition,
  type RevealTarget,
} from './editor-context';
import { toast } from 'sonner';
import { toastError } from '../../lib/errors';
import { warmEditorChunk } from '../editor/lazy-editor-parts';
import { warmTerminalChunk } from '../terminal/LazyTerminal';
import { wsManager } from '../../lib/ws';
import { registerHotkey } from '../../lib/hotkeys';
import { setScratchpadInsertHandler } from '../scratchpad/scratchpad-store';
import { KeepAliveHost } from './keep-alive';
import { allLeaves, flattenTabs, pruneTabs, tabRefKey, type DropEdge } from './layout-tree';
import { scopeUiState, splitToProjects, unionToProfile } from './project-layout';
import { projectAbbrev } from '../../lib/project-abbrev';
import { NARROW_VIEWPORT, useMediaQuery } from '../../lib/use-media-query';
import { layoutForPanels } from './panel-layout';
import {
  CollapsedSidebarRail,
  NavigatorSidebar,
  normalizeSidebarMode,
  type SidebarMode,
} from './NavigatorSidebar';
import { NewSessionDialog } from './NewSessionDialog';
import { CollapsedSessionsRail, SessionSidebar, type SessionGroup } from './SessionSidebar';
import { TileTree } from './TileTree';
import { TilingDnd } from './TilingDnd';
import { useLayoutTree } from './useLayoutTree';
import { useUiState } from './use-ui-state';

/**
 * Project workspace (SPEC §8): the left navigator, the centre free-form tiling
 * area (editor + terminal tabs in `layout_tree`, driven by `useLayoutTree`), and
 * the right session sidebar. The tiling tree and the shell sizes persist PER
 * PROFILE — the centre area is one surface shared across the profile's projects
 * — and restore on open (SPEC §11); the project-based layout setting narrows
 * the tree (not the shell) to per profile+project via `scopeUiState`. `EditorProvider` lets the explorer and
 * terminal links open files without prop-drilling; Monaco/xterm stay behind
 * lazy chunks (`KeepAliveHost` + the pane bodies).
 */
export function Workspace() {
  return (
    <EditorProvider>
      <WorkspaceInner />
    </EditorProvider>
  );
}

function WorkspaceInner() {
  const params = useParams();
  const navigate = useNavigate();
  const createSession = useCreateSession();
  const projectId = params['id'] ?? '';
  const validProject = /^[0-9a-f]{10}$/.test(projectId);
  const activeSessionId = params['sid'] ?? null;
  const detail = useProjectDetail(validProject ? projectId : undefined);
  const sessions = useMemo(() => detail.data?.sessions ?? [], [detail.data]);
  const accounts = useAccounts(detail.data?.project.profile_id).data ?? [];
  const renderTitle = useSessionTitleRenderer();

  // Profile-keyed (SPEC §11): the layout tree is shared across projects, so the
  // tiling area needs every session it may hold a tab for — whatever the
  // project — for labels, status dots, and restore-time pruning.
  const baseUiState = useUiState();
  const allSessions = useAllSessions();
  const tabSessions = allSessions.data ?? sessions;

  // Project-based layout (SPEC §11, client setting): the centre editor keeps a
  // layout per project instead of one profile-wide surface. Scoping waits for
  // the snapshot to say `layout_mode: 'project'` — the transition effect below
  // converts it — so a snapshot mid-transition is never read through the wrong
  // keys. Everything downstream uses the scoped handle; only the transition
  // and slice-prune effects reach for the base one.
  const projectMode = useClientSettings().projectBasedLayout;
  const uiState = scopeUiState(
    baseUiState,
    projectId,
    projectMode && baseUiState.snapshot.layout_mode === 'project',
  );
  const baseUiStateRef = useRef(baseUiState);
  baseUiStateRef.current = baseUiState;

  // The right sidebar groups sessions by project (SPEC §12): every project's
  // sessions in the default profile-based layout (project order inherits the
  // homescreen's projectOrder, and the groups derive from the same
  // all-sessions list the tiling area uses), or just the current project's
  // under project-based layout — project names always stay as navigation
  // targets; drag reorders session_order in both.
  const profileId = detail.data?.project.profile_id;
  const profileProjects = useProjects(profileId);
  const profileSettings = useProfileSettings(profileId);
  const patchProfileSettings = usePatchProfileSettings(profileId ?? '');
  // The profile's live projects in sidebar order (the homescreen's
  // projectOrder) — the base for the session groups and for header drags.
  const orderedProjects = useMemo(() => {
    const projectRows = profileProjects.data ?? (detail.data ? [detail.data.project] : []);
    return orderByDrag(
      projectRows.filter((p) => !p.archived),
      profileSettings.data?.projectOrder ?? [],
    );
  }, [profileProjects.data, detail.data, profileSettings.data]);
  const sessionGroups = useMemo<SessionGroup[]>(() => {
    const active = (s: Session) => s.status !== 'archived';
    const all = allSessions.data ?? sessions;
    return orderedProjects.map((p) => ({
      projectId: p.id,
      name: p.name,
      abbrev: projectAbbrev(p),
      repoId: p.repo_id,
      // Each group applies the same saved order the single-project view uses
      // (untracked sessions float to the top of their group, newest-first).
      sessions: orderByDrag(
        all.filter(
          (s) => s.project_id === p.id && active(s) && (!projectMode || p.id === projectId),
        ),
        uiState.snapshot.session_order,
      ),
    }));
  }, [
    projectMode,
    sessions,
    projectId,
    uiState.snapshot.session_order,
    orderedProjects,
    allSessions.data,
  ]);
  // A sidebar project-header drag persists into the SAME projectOrder the
  // homescreen cards drag (SPEC §11) — one source of truth for project order.
  // dragover fires continuously, so identical orders never re-persist.
  const moveProject = useCallback(
    (dragId: string, beforeId: string) => {
      const ids = orderedProjects.map((p) => p.id);
      const next = reorderIds(ids, dragId, beforeId);
      if (next.some((id, i) => id !== ids[i])) patchProfileSettings.mutate({ projectOrder: next });
    },
    [orderedProjects, patchProfileSettings],
  );
  // The archived disclosure follows the same scoping as the live groups
  // (SPEC §12): only this project's archived sessions under project-based
  // layout, every project's (in sidebar project order) otherwise.
  const archivedSessions = useMemo(() => {
    if (projectMode) return sessions.filter((s) => s.status === 'archived');
    const all = allSessions.data ?? sessions;
    return orderedProjects.flatMap((p) =>
      all.filter((s) => s.project_id === p.id && s.status === 'archived'),
    );
  }, [projectMode, sessions, allSessions.data, orderedProjects]);

  // One-shot layout-mode transitions (SPEC §11): when the client's
  // project-based layout setting disagrees with the mode the snapshot was last
  // maintained in, convert it — split the shared tree into per-project slices
  // on the way in, union the slices back on the way out — and stamp
  // `layout_mode`, so a snapshot converts exactly once even when the setting
  // flipped while no workspace was open (or in another browser).
  const orderedProjectsRef = useRef(orderedProjects);
  orderedProjectsRef.current = orderedProjects;
  useEffect(() => {
    const base = baseUiStateRef.current;
    if (!base.loaded) return;
    const snap = base.current();
    const mode = snap.layout_mode ?? 'profile';
    if (projectMode && mode !== 'project') {
      // The split needs the session → project map and the full project list
      // (archived projects included — their sessions' tabs must land
      // somewhere); wait until both have arrived.
      if (!allSessions.data || !profileProjects.data) return;
      const sessionProject = new Map(allSessions.data.map((s) => [s.id, s.project_id]));
      base.update(
        splitToProjects(
          snap,
          profileProjects.data.map((p) => p.id),
          sessionProject,
          projectId,
        ),
      );
    } else if (!projectMode && mode === 'project') {
      // Union order: the current project's slice leads, the rest follow the
      // sidebar's project order.
      base.update(
        unionToProfile(snap, [projectId, ...orderedProjectsRef.current.map((p) => p.id)]),
      );
    }
  }, [projectMode, baseUiState.loaded, allSessions.data, profileProjects.data, projectId]);

  const layout = useLayoutTree(
    uiState,
    projectMode && baseUiState.snapshot.layout_mode === 'project'
      ? `project:${projectId}`
      : 'profile',
  );
  // Effects reference the controller through a ref so they don't list `layout`
  // (which changes on every tree edit) as a dependency — otherwise a
  // focus/ensure op would re-trigger the effect that made it, looping.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  // `useUiState` returns a fresh handle object every render, so effects must
  // reach it through a ref — listing `uiState` in a dependency array would fire
  // the effect on EVERY render, not only when its real inputs change.
  const uiStateRef = useRef(uiState);
  uiStateRef.current = uiState;
  // Reorder-persist, shared by the expanded sidebar and the collapsed rail:
  // merge so a single-project reorder never forgets hidden projects' sessions.
  const persistReorder = useCallback(
    (ids: string[]) =>
      uiStateRef.current.update({
        session_order: mergeOrder(ids, uiStateRef.current.snapshot.session_order),
      }),
    [],
  );
  // Narrow (phone) layout, SPEC §12: the sidebars leave the panel row and
  // open as overlays from their rails. Overlay visibility is LOCAL state, not
  // ui_state — the persisted collapse flags belong to the desktop layout, and
  // a phone visit must not clobber them (ui_state is shared per profile).
  const isNarrow = useMediaQuery(NARROW_VIEWPORT);
  const isNarrowRef = useRef(isNarrow);
  isNarrowRef.current = isNarrow;
  const [narrowNav, setNarrowNav] = useState(false);
  const [narrowSessions, setNarrowSessions] = useState(false);
  // Restore-on-open runs once per project VISIT, not per mount: switching
  // projects in the sidebar re-runs it against the new project's stored
  // active session (which per-project layouts make a distinct value).
  const [restoredProject, setRestoredProject] = useState<string | null>(null);
  const restored = restoredProject === projectId;
  const [creating, setCreating] = useState(false);
  const [createKind, setCreateKind] = useState<SessionKind>('agent');
  const [seedAccountId, setSeedAccountId] = useState<number | undefined>(undefined);
  // Where the create dialogue lands its session: null = the current project;
  // a project-header context menu retargets it (SPEC §12) via `openCreateIn`.
  const [createTarget, setCreateTarget] = useState<{ projectId: string; repoId: number } | null>(
    null,
  );
  const openCreate = useCallback(
    (kind: SessionKind = 'agent', target?: { projectId: string; repoId: number }) => {
      setSeedAccountId(undefined);
      setCreateTarget(target ?? null);
      setCreateKind(kind);
      setCreating(true);
    },
    [],
  );
  // "New agent/terminal in this project" from a project header's right-click:
  // the SAME create dialogue, seeded with that project instead of the current.
  const openCreateIn = useCallback(
    (kind: SessionKind, pid: string) => {
      const p = orderedProjects.find((x) => x.id === pid);
      openCreate(kind, p ? { projectId: p.id, repoId: p.repo_id } : undefined);
    },
    [orderedProjects, openCreate],
  );
  // Set when the active tab is closed: the router clears the URL param a
  // render later, so this stops the deep-link effect resurrecting the tab in
  // the interim (it would otherwise leave a zombie header — no active session).
  const justClosedActive = useRef<string | null>(null);
  const { setHandler } = useNewSession();

  // Opening any tab from a navigator (files tree, diff list, history list) or a
  // Phase 4 terminal link adds/focuses its editor tab and makes it active —
  // pure ui-state, so it works before the lazy editor chunk loads. A `position`
  // arrives with a fresh nonce so the editor zone reveals the caret even when
  // the same file tab was already open (only meaningful for file tabs).
  const [reveal, setReveal] = useState<RevealTarget | null>(null);
  const openEditorTab = useCallback(
    (tab: EditorTab, position?: EditorPosition, opts?: { preview?: boolean }) => {
      layout.openEditor(tab, { preview: opts?.preview });
      // On a phone the navigator overlay covers the pane it just opened into.
      if (isNarrowRef.current) setNarrowNav(false);
      if (position && (tab.kind ?? 'file') === 'file') {
        setReveal({
          session: tab.session,
          path: tab.path,
          line: position.line,
          column: position.column,
          nonce: Date.now(),
        });
      }
    },
    [layout],
  );
  // Stable file-open handler for terminal links, the explorer, and the editor
  // context (keeps the original `(session, path, position?)` shape). Opens are
  // permanent by default; the explorer opts into preview per single-vs-double
  // click (VSCode-style).
  const openFile = useCallback(
    (
      sessionId: string,
      path: string,
      position?: EditorPosition,
      opts?: { preview?: boolean; view?: 'source' | 'preview' },
    ) =>
      openEditorTab(
        { kind: 'file', session: sessionId, path, ...(opts?.view ? { view: opts.view } : {}) },
        position,
        opts,
      ),
    [openEditorTab],
  );
  useEditorHandler(openFile);
  // Explorer clicks: a single click opens an ephemeral preview tab; a double
  // click opens (or promotes to) a permanent one.
  const openTreeFile = useCallback(
    (sessionId: string, path: string, opts?: { preview?: boolean }) =>
      openFile(sessionId, path, undefined, { preview: opts?.preview ?? true }),
    [openFile],
  );
  // "Open terminal in directory" from the file tree's context menu: a terminal
  // session joining the SAME worktree, whose shell simply starts in the folder
  // that was right-clicked (SPEC §8). It belongs to the worktree like any other
  // terminal — only the initial cwd differs.
  const openTerminalIn = useCallback(
    (sessionId: string, dir: string) => {
      const owner = sessions.find((s) => s.id === sessionId);
      if (!owner) return;
      createSession.mutate(
        {
          project_id: owner.project_id,
          kind: 'terminal',
          separate_branch: false,
          separate_worktree: false,
          join_worktree: owner.worktree_path,
          cwd: dir,
        },
        {
          onSuccess: (t) => void navigate(`/project/${t.project_id}/session/${t.id}`),
          onError: (e) => toastError(e),
        },
      );
    },
    [sessions, createSession, navigate],
  );
  const promoteTab = useCallback((ref: TabRef) => layout.promote(ref), [layout]);
  // Files opened from the explorer's parent-directory browse: a read-only
  // `external` tab carrying its browse root (SPEC §8). Preview by default,
  // like tree clicks.
  const openExternalFile = useCallback(
    (sessionId: string, path: string, root: string, opts?: { preview?: boolean }) =>
      openEditorTab({ kind: 'external', session: sessionId, path, root }, undefined, {
        preview: opts?.preview ?? true,
      }),
    [openEditorTab],
  );

  // Double-click on a strip's blank tail: a fresh untitled draft (SPEC §8) —
  // worktree-AGNOSTIC, held in the profile's untitled store until ⌘S places
  // it into the bound worktree via the save-as dialogue below. The nil-uuid
  // `session` keeps the tab schema-valid while binding to nothing.
  const qc = useQueryClient();
  // Feature-detect the untitled store (PROTOCOL.md rule 3): on a pre-10.3
  // daemon the POST would 404, which reads as a bug rather than a version
  // gap — say what is actually missing. Unknown (still fetching) reads as
  // supported, like every other gate.
  const daemonProtocol = useDaemonVersion().data?.protocol;
  const untitledSupported =
    !daemonProtocol ||
    daemonProtocol.major > 10 ||
    (daemonProtocol.major === 10 && daemonProtocol.minor >= 3);
  const onNewUntitled = useCallback(
    (_leaf: LayoutLeaf) => {
      if (profileId === undefined) return;
      if (!untitledSupported) {
        toast.error('Untitled drafts need a newer daemon — refresh the connection to update it');
        return;
      }
      createUntitled(profileId)
        .then(({ name }) =>
          openEditorTab({ kind: 'untitled', session: UNTITLED_SESSION, path: name }),
        )
        .catch((e: unknown) =>
          toast.error(e instanceof Error ? e.message : 'Could not create a draft'),
        );
    },
    [openEditorTab, profileId, untitledSupported],
  );

  // Save-as for untitled drafts: pick a path in the BOUND worktree, write it
  // there, drop the draft, and swap the tab for an ordinary file tab.
  const [savingUntitled, setSavingUntitled] = useState<UntitledSaveRequest | null>(null);
  useEffect(() => {
    setUntitledSaveHandler(setSavingUntitled);
    return () => setUntitledSaveHandler(null);
  }, []);

  // Closing an untitled tab discards its draft — confirmed first, since the
  // draft file is deleted with it (nothing lists orphaned drafts).
  const [discardingUntitled, setDiscardingUntitled] = useState<{
    leafId: string;
    ref: TabRef;
  } | null>(null);
  const confirmDiscardUntitled = () => {
    const d = discardingUntitled;
    setDiscardingUntitled(null);
    if (!d || d.ref.type !== 'editor') return;
    const name = d.ref.tab.path;
    if (profileId !== undefined) void deleteUntitled(profileId, name).catch(() => undefined);
    forgetUntitledContent(name);
    layout.close(d.leafId, d.ref);
  };

  // A saved draft: drop its untitled tab (wherever it sits) and open the real
  // file tab in its place. Two layout ops, deliberately split across a tick —
  // each op persists against the tree its render saw, so the second must run
  // after the first has committed.
  const finishUntitledSave = (name: string, sessionId: string, path: string) => {
    setSavingUntitled(null);
    const ref: TabRef = {
      type: 'editor',
      tab: { kind: 'untitled', session: UNTITLED_SESSION, path: name },
    };
    const key = tabRefKey(ref);
    for (const leaf of allLeaves(layoutRef.current.tree)) {
      if (leaf.tabs.some((t) => tabRefKey(t) === key)) layoutRef.current.close(leaf.id, ref);
    }
    void qc.invalidateQueries({ queryKey: ['wt-tree', sessionId] });
    setTimeout(() => {
      layoutRef.current.openEditor({ kind: 'file', session: sessionId, path });
    }, 0);
  };

  // The ⌘K palette, top bar, and profile panel reuse this modal; an account
  // id seeds the picker (profile panel → session on a chosen account).
  useEffect(() => {
    setHandler((opts) => {
      setSeedAccountId(opts?.accountId);
      setCreateKind(opts?.kind ?? 'agent');
      setCreating(true);
    });
    return () => setHandler(null);
  }, [setHandler]);

  // Reload must not suspend mid-restore: mounting the restored tree while the
  // Monaco/xterm chunks are still cold suspended EVERY pane into its fallback
  // ("Loading editor…" / a blank terminal) — and the reveal only reached the
  // screen on the next render (a tab click). Warm exactly the chunks the
  // restored tabs need behind the existing loading gate; once warm, the lazy
  // wrappers render their components directly, with no Suspense pass at all.
  // A terminal-only workspace still loads no Monaco (SPEC §8); an empty one
  // warms nothing. `.finally`: a failed import degrades to the old lazy path
  // rather than wedging the workspace.
  const [chunksReady, setChunksReady] = useState(false);
  useEffect(() => {
    if (!uiState.loaded || chunksReady) return;
    const tabs = flattenTabs(layoutRef.current.tree);
    void Promise.all([
      tabs.some((t) => t.type === 'terminal') ? warmTerminalChunk() : undefined,
      tabs.some((t) => t.type === 'editor') ? warmEditorChunk() : undefined,
    ]).finally(() => setChunksReady(true));
  }, [uiState.loaded, chunksReady]);

  // Restore-on-open: land on the stored active session unless the URL already
  // deep-links one. Navigation only follows a stored session of THIS project
  // (the project detail's own list decides — entering project A must not yank
  // the URL to wherever the profile last worked), so restore never waits on
  // anything beyond the detail fetch and terminals open immediately.
  useEffect(() => {
    if (restored || !uiState.loaded || !detail.data) return;
    setRestoredProject(projectId);
    const stored = uiState.snapshot.active_session;
    const storedSession = sessions.find((s) => s.id === stored);
    if (!activeSessionId && storedSession && storedSession.status !== 'archived') {
      void navigate(`/project/${projectId}/session/${storedSession.id}`, { replace: true });
    }
  }, [restored, uiState, detail.data, sessions, activeSessionId, navigate, projectId]);

  // Prune dead tabs (and dead session_order ids) once per mount, whenever the
  // FULL session list first arrives — decoupled from `restored` so a slow or
  // transiently failing fetch neither blocks the workspace nor forfeits the
  // prune for the window's lifetime. The alive set must span EVERY session on
  // the daemon: the profile-keyed tree holds cross-project tabs, and pruning
  // against one project's list would wipe the rest.
  const pruned = useRef(false);
  useEffect(() => {
    if (pruned.current || !uiState.loaded || !allSessions.data) return;
    pruned.current = true;
    const alive = new Set(allSessions.data.filter((s) => s.status !== 'archived').map((s) => s.id));
    layoutRef.current.pruneSessions(alive);
    // Project-based slices hold trees the visible prune above never touches
    // (it sees only the scoped tree) — prune every stored slice the same way.
    // Read through current(): the visible prune has already written this tick.
    const base = baseUiStateRef.current;
    const record = base.current().project_layouts;
    if (Object.keys(record).length > 0) {
      const keep = (ref: TabRef) =>
        alive.has(ref.type === 'terminal' ? ref.session : ref.tab.session);
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
  }, [uiState.loaded, allSessions.data]);

  // A genuine session navigation (the URL `sid` changed) ensures a terminal for
  // that session and focuses it — added to the currently focused pane if absent,
  // else just focused — and records it as the stored active session (for reload
  // restore + the left-sidebar bind). This must fire ONCE per navigation, not on
  // every render: re-running it would re-assert the session's terminal as its
  // leaf's active tab, so clicking a file tab that shares the pane would flip
  // straight back to the terminal. Hence the ref-based `uiState`/`layout` access
  // and the deps limited to what actually changes on navigation.
  useEffect(() => {
    if (!restored) return;
    // Navigation is how a phone picks a session — the overlay's job is done.
    setNarrowSessions(false);
    if (!activeSessionId) {
      justClosedActive.current = null; // close completed; the URL caught up
      return;
    }
    // Don't re-open the tab we're closing while the URL param still lags.
    if (activeSessionId === justClosedActive.current) return;
    justClosedActive.current = null;
    // Single-click navigation opens the session as an ephemeral preview tab
    // (VSCode-style); double-clicking its tab promotes it to permanent.
    layoutRef.current.ensureTerminal(activeSessionId, { preview: true });
    const ui = uiStateRef.current;
    if (ui.snapshot.active_session !== activeSessionId) {
      ui.update({ active_session: activeSessionId });
    }
  }, [restored, activeSessionId]);

  // waiting_input is mirrored in the tab title (SPEC §12). The title's base
  // is the machine's label (display-name customisation first, then hostname),
  // not the app name — the window says which host and project it drives.
  const host = useHostInfo();
  useEffect(() => {
    const base = hostLabel(host.data) ?? 'puddle';
    const waiting = sessions.filter((s) => s.status === 'waiting_input').length;
    const name = detail.data?.project.name ?? 'puddle';
    document.title = waiting > 0 ? `● ${waiting} waiting — ${name}` : `${name} — ${base}`;
    return () => {
      document.title = base;
    };
  }, [sessions, detail.data?.project.name, host.data]);

  // Closing a session from the sidebar / its lifecycle menu removes its terminal
  // from the tree; if it was the URL-bound one, drop the binding.
  const closeTab = useCallback(
    (id: string) => {
      const wasActive = activeSessionId === id;
      if (wasActive) justClosedActive.current = id;
      layout.removeTerminal(id);
      if (wasActive) {
        uiState.update({ active_session: null });
        void navigate(`/project/${projectId}`);
      }
    },
    [layout, uiState, activeSessionId, navigate, projectId],
  );

  // Activating a tab focuses its pane; activating a terminal also navigates so
  // the left sidebar binds to it. A terminal tab may belong to ANOTHER project
  // (the cross-project sidebar can open one here), so navigate to the session's
  // OWN project — otherwise the URL keeps this project and the file tree, bound
  // to a session it doesn't own, shows empty. Closing a pane tab mirrors `closeTab`.
  const onActivateTab = useCallback(
    (leafId: string, ref: TabRef) => {
      layout.activate(leafId, ref);
      if (ref.type === 'terminal' && ref.session !== activeSessionId) {
        // Navigate only when the owner is KNOWN: guessing the current project
        // while the all-sessions list is still loading would bind another
        // project's session under the wrong URL (empty header + file tree).
        // The tab itself activates regardless; the URL catches up on the next
        // click once the list has landed. Already-bound sessions skip the
        // navigate — pane-body clicks would otherwise pile up history entries.
        const owner = tabSessions.find((s) => s.id === ref.session)?.project_id;
        if (owner) void navigate(`/project/${owner}/session/${ref.session}`);
      }
    },
    [layout, navigate, tabSessions, activeSessionId],
  );
  const onCloseTab = useCallback(
    (leafId: string, ref: TabRef) => {
      // Closing an untitled tab discards its profile-store draft — confirm
      // first (the dialogue below); nothing else lists orphaned drafts.
      if (ref.type === 'editor' && tabKind(ref.tab) === 'untitled') {
        setDiscardingUntitled({ leafId, ref });
        return;
      }
      layout.close(leafId, ref);
      if (ref.type === 'terminal' && ref.session === activeSessionId) {
        justClosedActive.current = ref.session;
        uiState.update({ active_session: null });
        void navigate(`/project/${projectId}`);
      }
    },
    [layout, activeSessionId, uiState, navigate, projectId],
  );
  // A sidebar drag (file row / session row or dot) dropped onto a pane: open a
  // PERMANENT tab there through the same dropTab path strip drags use — centre
  // inserts, an edge splits — so a drag opens and positions in one gesture. A
  // dropped session also claims the URL, like activating its tab would.
  const onDropTab = useCallback(
    (leafId: string, ref: TabRef, edge: DropEdge) => {
      layout.drop({ ref, fromLeafId: leafId, toLeafId: leafId, edge });
      if (ref.type === 'terminal' && ref.session !== activeSessionId) {
        const owner = tabSessions.find((s) => s.id === ref.session)?.project_id;
        if (owner) void navigate(`/project/${owner}/session/${ref.session}`);
      }
    },
    [layout, activeSessionId, tabSessions, navigate],
  );

  // The whole left sidebar binds to one worktree: the pinned session if any,
  // otherwise the FOCUSED pane's active tab — every tab carries the worktree
  // it was opened from (a file tab its `session`, a terminal its own), so
  // Files, Changes, and Search follow whichever tab you are working in; the
  // URL-bound session is only the fallback for an empty pane (SPEC §8,
  // pin-across-tabs). Resolved against the full session list so cross-project
  // tabs and profile-wide pins bind while you visit another project.
  const focusedRef =
    layout.focusedLeaf.tabs.find((t) => tabRefKey(t) === layout.focusedLeaf.activeKey) ?? null;
  const rawFocusedSession =
    focusedRef === null
      ? null
      : focusedRef.type === 'terminal'
        ? focusedRef.session
        : focusedRef.tab.session;
  // An untitled tab binds to nothing (nil-uuid session) — fall through to the
  // URL-bound session rather than looking up a session that cannot exist.
  const focusedTabSession = rawFocusedSession === UNTITLED_SESSION ? null : rawFocusedSession;
  const sidebarTarget = useExplorerTarget(
    tabSessions,
    focusedTabSession ?? activeSessionId,
    uiState,
  );
  const targetSession = sidebarTarget.session;
  const sidebarMode: SidebarMode = normalizeSidebarMode(uiState.snapshot.sidebar_mode);
  const sidebarCollapsed = uiState.snapshot.sidebar_collapsed;
  const sessionsCollapsed = uiState.snapshot.sessions_collapsed;

  // Insert a Scratchpad entry into the focused terminal's stdin, wrapped in
  // bracketed-paste so a multi-line prompt lands as one paste and the agent
  // never submits on an embedded newline (SPEC §11). Only a focused *terminal*
  // tab accepts stdin; otherwise nudge the user to focus one.
  const insertPrompt = useCallback(
    (text: string) => {
      const leaf = layout.focusedLeaf;
      const ref = leaf.tabs.find((t) => tabRefKey(t) === leaf.activeKey) ?? null;
      if (!ref || ref.type !== 'terminal') {
        toast.error('Focus a terminal or agent to insert');
        return;
      }
      wsManager.write(ref.session, 'agent', `\x1b[200~${text}\x1b[201~`);
    },
    [layout],
  );
  // The top-bar Scratchpad popover pastes entries through this workspace's
  // focused terminal while it is mounted (scratchpad-store).
  useEffect(() => {
    setScratchpadInsertHandler(insertPrompt);
    return () => setScratchpadInsertHandler(null);
  }, [insertPrompt]);

  // Global hotkey handlers (SPEC §11): register stable wrappers once; each reads
  // the latest closures from a ref so re-renders don't churn the registry.
  const hkRef = useRef<Record<string, () => void>>({});
  const openNavigator = (mode: SidebarMode) => {
    if (isNarrow) {
      uiState.update({ sidebar_mode: mode });
      setNarrowNav(true);
    } else {
      uiState.update({ sidebar_mode: mode, sidebar_collapsed: false });
    }
  };
  hkRef.current = {
    'tab.close': () => {
      const leaf = layout.focusedLeaf;
      const ref = leaf.tabs.find((t) => tabRefKey(t) === leaf.activeKey);
      if (ref) onCloseTab(leaf.id, ref);
    },
    'sidebar.left': () =>
      isNarrow
        ? setNarrowNav((v) => !v)
        : uiState.update({ sidebar_collapsed: !uiState.snapshot.sidebar_collapsed }),
    'sidebar.right': () =>
      isNarrow
        ? setNarrowSessions((v) => !v)
        : uiState.update({ sessions_collapsed: !uiState.snapshot.sessions_collapsed }),
    'nav.files': () => openNavigator('files'),
    'nav.search': () => openNavigator('search'),
    'nav.changes': () => openNavigator('changes'),
    'nav.worktrees': () => openNavigator('worktrees'),
    'session.newAgent': () => openCreate('agent'),
    'session.newTerminal': () => openCreate('terminal'),
    // 'scratchpad.toggle' is registered by the top-bar popover (SPEC §11).
  };
  useEffect(() => {
    const ids = Object.keys(hkRef.current);
    const unregs = ids.map((id) => registerHotkey(id, () => hkRef.current[id]?.()));
    return () => unregs.forEach((u) => u());
  }, []);

  // Highlight the navigator entry for the focused pane's active editor tab.
  const activeTab = layout.activeEditorTab;
  const activeDiffPath =
    activeTab?.kind === 'diff' && targetSession && activeTab.session === targetSession.id
      ? activeTab.path
      : null;
  // Highlight the files-tree row whose file is the active editor tab (a legacy
  // snapshot's tab has no `kind`, meaning `file`).
  const activeFilePath =
    activeTab &&
    (activeTab.kind ?? 'file') === 'file' &&
    targetSession &&
    activeTab.session === targetSession.id
      ? activeTab.path
      : null;

  // A changes / commit-file / search-result click opens its content as a
  // centre-editor tab against the BOUND worktree (openEditorTab dedupes).
  const openDiff = (path: string) => {
    if (targetSession) openEditorTab({ kind: 'diff', session: targetSession.id, path });
  };
  const openCommitFile = (path: string, sha: string) => {
    if (targetSession) openEditorTab({ kind: 'commit', session: targetSession.id, path, sha });
  };
  const openSearchFile = (path: string, line?: number) => {
    if (targetSession)
      openFile(targetSession.id, path, line !== undefined ? { line, column: 1 } : undefined);
  };

  // The horizontal shell (nav | main | sessions) persists its sizes into the
  // flat `layout` object via `layoutForPanels`/merge, exactly as before — the
  // tiling area inside `main` carries its own per-split sizes in `layout_tree`.
  // `onLayoutChanged` merges the shell's keys so it never wipes unrelated ones.
  const mergeLayout = useCallback(
    (next: Layout) => uiState.update({ layout: { ...uiState.snapshot.layout, ...next } }),
    [uiState],
  );
  // The nav and sessions panels join the horizontal Group only while expanded
  // (collapsed, a slim rail sits outside the Group), keeping the restore count exact.
  const horizontalLayout = layoutForPanels(uiState.snapshot.layout, [
    ...(sidebarCollapsed ? [] : ['nav']),
    'main',
    ...(sessionsCollapsed ? [] : ['sessions']),
  ]);

  if (!validProject) return null;
  if (!uiState.loaded || !detail.data || !chunksReady) {
    return <div className="flex h-full items-center justify-center text-sm text-fg-muted">…</div>;
  }

  // The sidebars render identically in both layouts; only the collapse/close
  // action differs (panel-collapse on desktop, overlay-dismiss on a phone).
  const navigatorPanel = (onCollapse: () => void) => (
    <NavigatorSidebar
      mode={sidebarMode}
      onModeChange={(m) => uiState.update({ sidebar_mode: m })}
      onCollapse={onCollapse}
      projectId={projectId}
      repoId={detail.data.project.repo_id}
      sessions={sessions}
      target={sidebarTarget}
      onOpenFile={openTreeFile}
      onOpenExternalFile={openExternalFile}
      onOpenTerminalIn={openTerminalIn}
      activeFilePath={activeFilePath}
      activeDiffPath={activeDiffPath}
      onOpenDiff={openDiff}
      onOpenCommitFile={openCommitFile}
      onOpenSearchFile={openSearchFile}
    />
  );
  const projectActions = {
    onNewSessionIn: (pid: string) => openCreateIn('agent', pid),
    onNewTerminalIn: (pid: string) => openCreateIn('terminal', pid),
    onMoveProject: moveProject,
  };
  const sessionsPanel = (onCollapse: () => void) => (
    <SessionSidebar
      groups={sessionGroups}
      accounts={accounts}
      activeSessionId={activeSessionId}
      onReorder={persistReorder}
      onPromote={(id) => layout.ensureTerminal(id)}
      archived={archivedSessions}
      onNewSession={() => openCreate('agent')}
      onNewTerminal={() => openCreate('terminal')}
      onCollapse={onCollapse}
      onArchived={closeTab}
      onArchiveDrop={archiveFromDrag}
      projectActions={projectActions}
    />
  );
  // A session dropped on an archive target (rail icon / list header): archive
  // it — no confirmation, nothing is destroyed (SPEC §4) — and drop its tab.
  const archiveSession = useArchiveSession();
  const archiveFromDrag = useCallback(
    (id: string) =>
      archiveSession.mutate(id, {
        onSuccess: () => closeTab(id),
        onError: (e) => toastError(e),
      }),
    [archiveSession, closeTab],
  );

  // Free-form tiling area (SPEC §8): editor and terminal tabs live in a
  // recursive split tree (`layout_tree`); every open terminal is kept mounted
  // by `KeepAliveHost` and its DOM adopted into whichever pane shows it, so
  // PTYs never drop. A session's resume button and ports overlay the
  // bottom-right of ITS OWN pane (PaneSessionOverlay). The DnD context wraps
  // the WHOLE workspace (not just this area) so a strip drag can land on the
  // sidebar's archive targets.
  const mainArea = (
    <div className="flex h-full flex-col bg-ground">
      <div className="min-h-0 flex-1">
        <TileTree
          tree={layout.tree}
          sessions={tabSessions}
          reveal={reveal}
          onActivateTab={onActivateTab}
          onCloseTab={onCloseTab}
          onPromoteTab={promoteTab}
          onArchived={closeTab}
          onFocusLeaf={layout.focusLeaf}
          onResize={layout.resize}
          onDropTab={onDropTab}
          onSetTabView={layout.setView}
          onNewUntitled={onNewUntitled}
        />
      </div>
    </div>
  );

  // KeepAliveHost wraps BOTH layouts: crossing the breakpoint (a tablet
  // rotation, a resized window) swaps the shell without remounting it, so
  // open terminals keep their scrollback and PTY attachments.
  return (
    <KeepAliveHost
      tree={layout.tree}
      onOpenFile={(session, path, line, column) =>
        openFile(session, path, line !== undefined ? { line, column } : undefined)
      }
    >
      <TilingDnd
        onDrop={layout.drop}
        onArchive={archiveFromDrag}
        renderOverlay={(ref) => {
          const s =
            ref.type === 'terminal' ? tabSessions.find((x) => x.id === ref.session) : undefined;
          const label =
            ref.type === 'terminal'
              ? s
                ? renderTitle(s)
                : ref.session.slice(0, 8)
              : (ref.tab.path.split('/').pop() ?? ref.tab.path);
          return (
            <div className="rounded-md bg-elevated px-2.5 py-1 text-xs font-mono text-fg shadow-lg">
              {label}
            </div>
          );
        }}
      >
        <div className="relative flex h-full">
          {isNarrow ? (
            /* Narrow (SPEC §12): both rails stay put; expanding opens the sidebar
             as an overlay above the tiling area — a translucent ground dims
             what stays behind (HUMANS.md transparency, no borders). */
            <>
              <CollapsedSidebarRail
                mode={sidebarMode}
                onExpand={() => setNarrowNav(true)}
                onSelect={(m) => {
                  uiState.update({ sidebar_mode: m });
                  setNarrowNav(true);
                }}
              />
              <div className="min-w-0 flex-1">{mainArea}</div>
              <CollapsedSessionsRail
                groups={sessionGroups}
                accounts={accounts}
                activeSessionId={activeSessionId}
                onReorder={persistReorder}
                onPromote={(id) => layout.ensureTerminal(id)}
                onExpand={() => setNarrowSessions(true)}
                onNewTerminal={() => openCreate('terminal')}
                onNewSession={() => openCreate('agent')}
                onArchived={closeTab}
                onArchiveDrop={archiveFromDrag}
                projectActions={projectActions}
              />
              {narrowNav && (
                <>
                  <button
                    type="button"
                    aria-label="Close the navigator"
                    className="absolute inset-0 z-30 bg-ground/60"
                    onClick={() => setNarrowNav(false)}
                  />
                  <div className="absolute inset-y-0 left-9 z-40 w-[min(20rem,calc(100%-4.5rem))] shadow-xl">
                    {navigatorPanel(() => setNarrowNav(false))}
                  </div>
                </>
              )}
              {narrowSessions && (
                <>
                  <button
                    type="button"
                    aria-label="Close the session list"
                    className="absolute inset-0 z-30 bg-ground/60"
                    onClick={() => setNarrowSessions(false)}
                  />
                  <div className="absolute inset-y-0 right-9 z-40 w-[min(20rem,calc(100%-4.5rem))] shadow-xl">
                    {sessionsPanel(() => setNarrowSessions(false))}
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              {sidebarCollapsed && (
                <CollapsedSidebarRail
                  mode={sidebarMode}
                  onExpand={() => uiState.update({ sidebar_collapsed: false })}
                  onSelect={(m) => uiState.update({ sidebar_collapsed: false, sidebar_mode: m })}
                />
              )}
              <Group
                orientation="horizontal"
                className="h-full min-w-0 flex-1"
                defaultLayout={horizontalLayout}
                onLayoutChanged={mergeLayout}
              >
                {!sidebarCollapsed && (
                  <>
                    <Panel id="nav" defaultSize={280} minSize={200} maxSize={560}>
                      {navigatorPanel(() => uiState.update({ sidebar_collapsed: true }))}
                    </Panel>
                    <Separator className="w-px bg-border transition-colors hover:bg-accent data-[resizing]:bg-accent" />
                  </>
                )}
                <Panel id="main">{mainArea}</Panel>
                {!sessionsCollapsed && (
                  <>
                    <Separator className="w-px bg-border transition-colors hover:bg-accent data-[resizing]:bg-accent" />
                    <Panel id="sessions" defaultSize={260} minSize={180} maxSize={480}>
                      {sessionsPanel(() => uiState.update({ sessions_collapsed: true }))}
                    </Panel>
                  </>
                )}
              </Group>
              {sessionsCollapsed && (
                <CollapsedSessionsRail
                  groups={sessionGroups}
                  accounts={accounts}
                  activeSessionId={activeSessionId}
                  onReorder={persistReorder}
                  onPromote={(id) => layout.ensureTerminal(id)}
                  onExpand={() => uiState.update({ sessions_collapsed: false })}
                  onNewTerminal={() => openCreate('terminal')}
                  onNewSession={() => openCreate('agent')}
                  onArchived={closeTab}
                  onArchiveDrop={archiveFromDrag}
                  projectActions={projectActions}
                />
              )}
            </>
          )}
          <NewSessionDialog
            projectId={createTarget?.projectId ?? projectId}
            repoId={createTarget?.repoId ?? detail.data.project.repo_id}
            open={creating}
            kind={createKind}
            seedAccountId={seedAccountId}
            onOpenChange={setCreating}
            // Navigate to the session's OWN project — a header context menu can
            // create it in a project other than the one the URL names.
            onCreated={(session) =>
              void navigate(`/project/${session.project_id}/session/${session.id}`)
            }
          />
          <UntitledSaveDialog
            request={savingUntitled}
            targetSession={targetSession}
            profileId={profileId}
            onClose={() => setSavingUntitled(null)}
            onSaved={finishUntitledSave}
          />
          <Dialog
            open={discardingUntitled !== null}
            onOpenChange={(open) => !open && setDiscardingUntitled(null)}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Discard this draft?</DialogTitle>
                <DialogDescription>
                  Closing an untitled tab deletes its draft — ⌘S saves it into the worktree instead.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setDiscardingUntitled(null)}>
                  Keep editing
                </Button>
                <Button variant="danger" onClick={confirmDiscardUntitled}>
                  Discard
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </TilingDnd>
    </KeepAliveHost>
  );
}
