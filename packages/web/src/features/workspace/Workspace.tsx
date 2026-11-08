import { ContentMotion } from '../../components/ui/content-motion';
import { TrayMotionProvider } from '../../components/ui/tray-motion';
import { animateSidebar } from './layout/animate-sidebar';
import { useAcceptWindowTransfer } from '../windows/transfers/use-window-transfer';
import { useArrangementReady } from '../windows/arrangements/use-arrangement-ready';
import { desktopProjectLayoutMode } from '../windows/use-desktop-state';
import { IslandSeparator } from './layout/IslandSeparator';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Group, Panel, type Layout } from 'react-resizable-panels';
import { UNTITLED_SESSION, type Session, type SessionKind, type TabRef } from '@puddle/shared';
import { useWorkspaceEditor } from '../editor/tabs/use-workspace-editor';
import { requestActiveTabSave } from '../editor/buffers/active-tab-save';
import { useWorkspaceDrafts } from './tabs/use-workspace-drafts';
import { usePaneClose } from '../windows/lifecycle/use-pane-close';
import {
  TabCloseRequests,
  tabCloseKey,
  useRequestEditorClose,
} from './tabs/close/TabCloseRequests';
import { useExplorerTarget } from '../explorer/use-explorer-target';
import { useWorkspaceFileNavigation } from '../explorer/use-workspace-file-navigation';
import {
  directoryTargetSupported,
  nativeConversationSyncSupported,
} from '../../lib/transport/protocol-support';
import { useWorkspaceCompilation } from '../editor/compilation/use-workspace-compilation';
import { useClientSettings } from '../../lib/settings/client-settings';
import { useSessionTitleRenderer } from '../profile/use-session-title';
import {
  useAccounts,
  useAllSessions,
  useCreateSession,
  useDaemonVersion,
  usePatchProfileSettings,
  useProfileSettings,
  useProjectDetail,
  useProjects,
  useRepos,
  refreshProjectConversations,
} from '../../lib/queries/queries';
import { mergeOrder, orderByDrag, reorderIds } from './sessions/session-order';
import { useNewSession } from '../shell/new-session-context';
import { EditorProvider } from './editor-context';
import { toast } from 'sonner';
import { toastError } from '../../lib/transport/errors';
import { wsManager } from '../../lib/transport/ws';
import { registerHotkey } from '../../lib/navigation/hotkeys';
import { setScratchpadInsertHandler } from '../scratchpad/scratchpad-store';
import { LocalPhonePane } from '../mobile/LocalPhonePane';
import { KeepAliveHost } from './keep-alive';
import { useWorkspaceTabs } from './tabs/use-workspace-tabs';
import { allLeaves, tabRefKey } from './layout/layout-tree';

import { projectAbbrev } from '../../lib/project-abbrev';
import { NARROW_VIEWPORT, useMediaQuery } from '../../lib/hooks/use-media-query';
import { layoutForPanels } from './layout/panel-layout';
import {
  CollapsedSidebarRail,
  NavigatorSidebar,
  normalizeSidebarMode,
  type SidebarMode,
} from './sidebar/NavigatorSidebar';
import { NewSessionDialog } from './sessions/NewSessionDialog';
import { SessionSidebar } from './sessions/SessionSidebar';
import { CollapsedSessionsRail } from './sessions/sidebar/CollapsedSessionsRail';
import type { SessionGroup } from './sessions/sidebar/types';
import { useSidebarSessionSelection } from './sessions/use-sidebar-session-selection';
import { TileTree } from './layout/TileTree';
import { TilingDnd } from './layout/TilingDnd';
import { useWorkspaceLayout } from './layout/use-workspace-layout';
import { useUiState } from './use-ui-state';
import { workspaceTitle } from './workspace-title';
import { useDocumentTitle } from '../shell/title/document-title';
import { desktopWindowContext } from '../windows/window-context';
import { ProjectRecovery } from '../windows/recovery/ProjectRecovery';
import { NativeWindowRecovery } from '../windows/recovery/NativeWindowRecovery';
import { closeRecoveredFile } from '../windows/recovery/recovery-close';
import { FileCloseScope } from './tabs/close/FileCloseScope';
import { useCurrentProfileId } from '../profile/profile-store';

/**
 * Project workspace (SPEC §8): the left navigator, the centre free-form tiling
 * area (editor + terminal tabs in `layout_tree`, driven by `useLayoutTree`), and
 * the right session sidebar. The tiling tree and the shell sizes persist PER
 * PROFILE — the shell sizes are one surface across the profile's projects — and
 * restore on open (SPEC §11); the project-based layout setting (ON by default
 * since 2026-08-04) narrows the TREE (not the shell) to per profile+project via
 * `scopeUiState`, so each project keeps its own panes. `EditorProvider` lets the explorer and
 * terminal links open files without prop-drilling; Monaco/xterm stay behind
 * lazy chunks (`KeepAliveHost` + the pane bodies).
 */
export function Workspace() {
  return (
    <TrayMotionProvider>
      <EditorProvider>
        <TabCloseRequests>
          <WorkspaceInner />
        </TabCloseRequests>
      </EditorProvider>
    </TrayMotionProvider>
  );
}

function WorkspaceInner() {
  const requestEditorClose = useRequestEditorClose();
  const windowIdentity = desktopWindowContext()?.identity;
  const selectedProfileId = useCurrentProfileId();
  const paneWindow = windowIdentity?.kind === 'pane';
  const detachedWindow = windowIdentity !== undefined && windowIdentity.kind !== 'host';
  const params = useParams();
  const navigate = useNavigate();
  const createSession = useCreateSession();
  const projectId = params['id'] ?? '';
  const validProject = /^[0-9a-f]{10}$/.test(projectId);
  const activeSessionId = params['sid'] ?? null;
  // The detail query keeps the PREVIOUS project's data while the next one is in
  // flight, so a project switch never unmounts this component (open terminals
  // keep their viewport, and a sidebar double-click is not yanked out from under
  // the second click). `projectDetail` is therefore the id-checked handle —
  // undefined until THIS project's own detail has landed — and everything that
  // must be about this project reads it. The stale row is still good for the
  // PROFILE, which a within-profile switch does not change.
  const detail = useProjectDetail(validProject ? projectId : undefined);
  const projectDetail = detail.data?.project.id === projectId ? detail.data : undefined;
  const accounts = useAccounts(detail.data?.project.profile_id).data ?? [];
  const renderTitle = useSessionTitleRenderer();
  const daemonProtocol = useDaemonVersion().data?.protocol;

  // Profile-keyed (SPEC §11): the layout tree is shared across projects, so the
  // tiling area needs every session it may hold a tab for — whatever the
  // project — for labels, status dots, and restore-time pruning.
  const baseUiState = useUiState();
  const allSessions = useAllSessions();
  // This project's sessions: its detail's list, or the all-sessions list
  // filtered — which is already in hand when the URL changes, so the navigators
  // never blink through an empty project while the detail is in flight.
  const sessions = useMemo(
    () =>
      projectDetail?.sessions ?? allSessions.data?.filter((s) => s.project_id === projectId) ?? [],
    [projectDetail, allSessions.data, projectId],
  );
  const tabSessions = allSessions.data ?? sessions;

  // Project-based layout (SPEC §11, client setting): the centre editor keeps a
  // layout per project instead of one profile-wide surface. Scoping waits for
  // the snapshot to say `layout_mode: 'project'` — the transition effect below
  // converts it — so a snapshot mid-transition is never read through the wrong
  // keys. Everything downstream uses the scoped handle; only the transition
  // and slice-prune effects reach for the base one.
  const clientSettingsNow = useClientSettings();
  const projectMode =
    !detachedWindow &&
    (desktopProjectLayoutMode(clientSettingsNow.projectBasedLayout) ??
      clientSettingsNow.projectBasedLayout);
  // Independent of the layout mode since 2026-08-03 (they were one setting
  // through v0.0.24): this one only decides whether the right sidebar lists
  // every project's sessions or just this project's.
  const showAllSessions = clientSettingsNow.showAllProjectSessions;
  // The right sidebar groups sessions by project (SPEC §12): every project's
  // sessions in the default profile-based layout (project order inherits the
  // homescreen's projectOrder, and the groups derive from the same
  // all-sessions list the tiling area uses), or just the current project's
  // under project-based layout — project names always stay as navigation
  // targets; drag reorders session_order in both.
  const profileId =
    projectDetail?.project.profile_id ??
    (windowIdentity && windowIdentity.kind !== 'host'
      ? windowIdentity.profileId
      : windowIdentity
        ? (selectedProfileId ?? undefined)
        : detail.data?.project.profile_id);
  const profileProjects = useProjects(profileId);
  usePaneClose(profileId ?? null);
  const profileSettings = useProfileSettings(profileId);
  const patchProfileSettings = usePatchProfileSettings(profileId ?? '');
  // THIS project's row: from its own detail once that lands, else from the
  // profile's project list — which already holds every project, so a switch
  // inside the profile knows the name, repo, and abbreviation at once and the
  // gate below never blanks for it. Only a cross-profile jump has neither.
  const project = projectDetail?.project ?? profileProjects.data?.find((p) => p.id === projectId);
  // The profile's live projects in sidebar order (the homescreen's
  // projectOrder) — the base for the session groups and for header drags.
  const orderedProjects = useMemo(() => {
    const projectRows = profileProjects.data ?? (project ? [project] : []);
    return orderByDrag(
      projectRows.filter((p) => !p.archived),
      profileSettings.data?.projectOrder ?? [],
    );
  }, [profileProjects.data, project, profileSettings.data]);
  const {
    uiState,
    projectScoped,
    scopeKey,
    layout,
    parkedSessions,
    chunksReady,
    focusLeaf,
    claimScrollDriver,
    scrollDriverLeafId,
  } = useWorkspaceLayout(baseUiState, {
    projectId,
    projectMode,
    sessions: allSessions.data,
    projects: profileProjects.data,
    orderedProjects,
  });
  useAcceptWindowTransfer(profileId, chunksReady && uiState.loaded);
  useArrangementReady(
    profileId,
    chunksReady && uiState.loaded && (!!project || (!!windowIdentity && !!detail.error)),
  );
  const sessionGroups = useMemo<SessionGroup[]>(() => {
    const active = (s: Session) => s.status !== 'archived';
    const all = allSessions.data ?? sessions;
    return orderedProjects.map((p) => ({
      projectId: p.id,
      name: p.name,
      abbrev: projectAbbrev(p),
      colour: p.colour,
      repoId: p.repo_id,
      collapsed: !showAllSessions && p.id !== projectId,
      // Each group applies the same saved order the single-project view uses
      // (untracked sessions float to the top of their group, newest-first).
      sessions: orderByDrag(
        all.filter((s) => s.project_id === p.id && active(s)),
        uiState.snapshot.session_order,
      ),
    }));
  }, [
    showAllSessions,
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
  // The archived disclosure, NEWEST CONVERSATION FIRST — by the very timestamp
  // its rows show (last activity, falling back to when it was created), so the
  // order you read is the order the list is in. Unlike the live groups it takes
  // no saved drag order: nothing is dragged in here, and "what was I last doing"
  // is the only question the list answers.
  //
  // A PROJECT-BASED layout never reaches past its own project (SPEC §12): the
  // whole point of that mode is that the window is about one project, and a
  // stranger's archived session offers nothing to do here. Profile-based layouts
  // keep the cross-project list, grouped in the sidebar's project order, when the
  // "all projects' sessions" client setting asks for it.
  const archivedSessions = useMemo(() => {
    const recency = (s: Session) => Date.parse(s.last_activity_at ?? s.created_at) || 0;
    const newestFirst = (rows: Session[]) => rows.sort((a, b) => recency(b) - recency(a));
    const archived = (s: Session) => s.status === 'archived';
    if (projectScoped || !showAllSessions) return newestFirst(sessions.filter(archived));
    const all = allSessions.data ?? sessions;
    return orderedProjects.flatMap((p) =>
      newestFirst(all.filter((s) => s.project_id === p.id && archived(s))),
    );
  }, [showAllSessions, projectScoped, sessions, allSessions.data, orderedProjects]);

  const compilation = useWorkspaceCompilation({
    layout,
    scopeKey,
    projectId,
    profileId,
    sessions: tabSessions,
    protocol: daemonProtocol,
  });
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
  const narrowViewport = useMediaQuery(NARROW_VIEWPORT);
  const isNarrow = !paneWindow && narrowViewport;
  const isNarrowRef = useRef(isNarrow);
  isNarrowRef.current = isNarrow;
  const [narrowNav, setNarrowNav] = useState(false);
  const [narrowSessions, setNarrowSessions] = useState(false);
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
  const { setHandler } = useNewSession();

  // A frontend transition schedules one coalesced native-store refresh. The
  // project renders from its normal cache while discovery runs in the daemon;
  // `sessions-changed` invalidates the catalogue only when rows actually move.
  useEffect(() => {
    if (!validProject || !nativeConversationSyncSupported(daemonProtocol)) return;
    void refreshProjectConversations(projectId).catch(() => undefined);
  }, [daemonProtocol, projectId, validProject]);

  const {
    openFile,
    openEditorTab,
    reveal,
    revealPreviewSource,
    revealCompiledSource,
    renameFileTab,
  } = useWorkspaceEditor({
    layout,
    baseUiState,
    claimScrollDriver,
    onOpen: () => {
      if (isNarrowRef.current) setNarrowNav(false);
    },
  });

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

  // The whole left sidebar binds to one worktree: the pinned session if any,
  // otherwise the FOCUSED pane's active tab — every tab carries the worktree
  // it was opened from (a file tab its `session`, a terminal its own), so
  // Files, Changes, and Search follow whichever tab you are working in; the
  // URL-bound session is only the fallback for an empty pane (SPEC §8,
  // pin-across-tabs). Resolved against the full session list so cross-project
  // tabs and profile-wide pins bind while you visit another project.
  const focusedRef =
    layout.focusedLeaf.tabs.find((t) => tabRefKey(t) === layout.focusedLeaf.activeKey) ?? null;
  const titleSession =
    focusedRef?.type === 'terminal'
      ? tabSessions.find((session) => session.id === focusedRef.session)
      : undefined;
  useDocumentTitle(
    'workspace',
    workspaceTitle(
      project?.name ?? (detail.error ? 'Unavailable project' : 'Project'),
      paneWindow ? focusedRef : null,
      titleSession ? renderTitle(titleSession) : undefined,
    ),
  );
  const rawFocusedSession =
    focusedRef === null
      ? null
      : focusedRef.type === 'terminal'
        ? focusedRef.session
        : focusedRef.tab.session;
  // An untitled tab binds to nothing (nil-uuid session) — fall through to the
  // URL-bound session rather than looking up a session that cannot exist.
  const focusedTabSession = rawFocusedSession === UNTITLED_SESSION ? null : rawFocusedSession;
  // …and when nothing qualifies — no session in focus, none in this project, or
  // none created yet — the sidebar binds to the PROJECT'S OWN directory rather
  // than showing four empty panels (SPEC §8, decision 2026-08-03). The daemon
  // resolves that through a directory target, so an older one keeps the empty
  // state instead of asking questions it would answer about the wrong repo.
  const repo = useRepos().data?.find((r) => r.id === project?.repo_id);
  const projectDirectory = useMemo(
    () =>
      directoryTargetSupported(daemonProtocol) && repo && project
        ? {
            path: repo.path,
            projectId: project.id,
            name: project.name,
            defaultBranch: repo.default_base_branch,
          }
        : null,
    [daemonProtocol, repo, project],
  );
  const sidebarTarget = useExplorerTarget(
    tabSessions,
    focusedTabSession ?? activeSessionId,
    uiState,
    projectDirectory,
  );
  const targetSession = sidebarTarget.session;
  const targetRoot = sidebarTarget.root;
  const drafts = useWorkspaceDrafts({
    baseUiState,
    scopeKey,
    projectId,
    targetSession,
    targetRoot,
    openEditorTab,
  });
  const {
    closeTab,
    onActivateTab,
    onCloseTab,
    onDropTab,
    reopenClosedTab,
    phoneSelection,
    phoneVisited,
    selectPhoneSession,
  } = useWorkspaceTabs({
    layout,
    uiState,
    scopeKey,
    projectScoped,
    sessions,
    allSessions: allSessions.data,
    projectReady: !!projectDetail,
    isNarrow,
    onNavigate: () => setNarrowSessions(false),
    claimScrollDriver,
    requestDiscard: drafts.requestDiscard,
  });
  const sidebarSessionSelection = useSidebarSessionSelection(sessionGroups, closeTab);

  const { browseRequest, filetreeRoot, rememberFiletreeRoot, revealFileTab, openFromTerminal } =
    useWorkspaceFileNavigation({
      uiState,
      sidebarTarget,
      tabSessions,
      openFile,
      scopeKey: `${profileId}:${projectId}:${scopeKey}`,
      isNarrow,
      showNavigator: () => setNarrowNav(true),
    });
  const sidebarMode: SidebarMode = normalizeSidebarMode(uiState.snapshot.sidebar_mode);
  const sidebarCollapsed = uiState.snapshot.sidebar_collapsed;
  const sessionsCollapsed = uiState.snapshot.sessions_collapsed;
  const [searchingSessions, setSearchingSessions] = useState(false);

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
  // Step through the FOCUSED pane's strip, wrapping at both ends — the tab
  // cycling hotkeys (SPEC §11). It goes through `onActivateTab`, so cycling onto
  // a terminal claims the URL exactly as clicking its chip would.
  const cycleTab = (step: 1 | -1) => {
    const leaf = layout.focusedLeaf;
    if (leaf.tabs.length < 2) return;
    const at = leaf.tabs.findIndex((t) => tabRefKey(t) === leaf.activeKey);
    // No active tab (an empty-ish pane): step in from the near end.
    const next = at === -1 ? (step === 1 ? 0 : leaf.tabs.length - 1) : at + step;
    const ref = leaf.tabs[(next + leaf.tabs.length) % leaf.tabs.length];
    if (ref) onActivateTab(leaf.id, ref);
  };
  const openNavigator = (mode: SidebarMode) => {
    if (isNarrow) {
      uiState.update({ sidebar_mode: mode });
      animateSidebar(() => setNarrowNav(true));
    } else {
      uiState.update({ sidebar_mode: mode, sidebar_collapsed: false });
    }
  };
  hkRef.current = {
    'tab.close': () => {
      const leaf = layout.focusedLeaf;
      const ref = leaf.tabs.find((t) => tabRefKey(t) === leaf.activeKey);
      if (ref?.type === 'editor') requestEditorClose(tabCloseKey(leaf.id, tabRefKey(ref)));
      else if (ref) onCloseTab(leaf.id, ref);
    },
    'tab.reopen': reopenClosedTab,
    // The keyboard route to the strip's double-click gesture: a fresh untitled
    // draft in the focused pane (SPEC §8).
    'tab.newUntitled': () => void drafts.create(),
    'tab.next': () => cycleTab(1),
    'tab.prev': () => cycleTab(-1),
    // Save is captured by the shell before Monaco and routed through this
    // LOGICAL active tab. A draggable chip can focus this pane while the DOM
    // caret remains in another pane's Monaco; document.activeElement must not
    // decide which file is written (SPEC §8).
    'editor.save': () => {
      requestActiveTabSave(layout.activeEditorTab);
    },
    'editor.compile': () => {
      const tab = layout.activeEditorTab;
      if (
        tab &&
        !tab.generated_by &&
        (tab.kind === undefined || tab.kind === 'file' || tab.kind === 'external')
      ) {
        void compilation.run(layout.focusedLeaf.id, tab);
      }
    },
    'sidebar.left': () =>
      isNarrow
        ? animateSidebar(() => setNarrowNav((v) => !v))
        : animateSidebar(() =>
            uiState.update({ sidebar_collapsed: !uiState.snapshot.sidebar_collapsed }),
          ),
    'sidebar.right': () =>
      isNarrow
        ? animateSidebar(() => setNarrowSessions((v) => !v))
        : animateSidebar(() =>
            uiState.update({ sessions_collapsed: !uiState.snapshot.sessions_collapsed }),
          ),
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
  // The same highlight for the browse tree above the worktree: an `external`
  // tab's path is relative to its own root, so the row only matches when that
  // root is the one currently being browsed (the sidebar decides).
  const activeExternalTab =
    activeTab?.kind === 'external' && activeTab.root !== undefined
      ? { path: activeTab.path, root: activeTab.root }
      : null;

  // A changes / commit-file / search-result click opens its content as a
  // centre-editor tab against the BOUND worktree (openEditorTab dedupes). Under
  // a directory target the tab carries that directory as its `root`, which is
  // both what its requests send and what keys it apart from a worktree tab for
  // the same relative path (SPEC §8).
  // Every one of them opens PREVIEW by default, exactly as a files-tree click
  // does (SPEC §8): a single click on a result is a peek that the next click
  // replaces in the same slot, and a double click — on the row or on its tab —
  // pins it. `opts.preview === false` is the pin.
  type OpenOpts =
    | {
        preview?: boolean;
        root?: string;
        gitArea?: import('@puddle/shared').GitArea;
      }
    | undefined;
  const previewing = (opts: OpenOpts) => ({ preview: opts?.preview ?? true });
  const openDiff = (path: string, opts?: OpenOpts) => {
    if (targetSession) {
      const diffRoot = opts?.root ?? targetRoot;
      const diffRooted = diffRoot === undefined ? {} : { root: diffRoot };
      openEditorTab(
        {
          kind: 'diff',
          session: targetSession.id,
          path,
          ...diffRooted,
          ...(opts?.gitArea === undefined ? {} : { git_area: opts.gitArea }),
        },
        undefined,
        previewing(opts),
      );
    }
  };
  const openCommitFile = (path: string, sha: string, opts?: OpenOpts) => {
    if (targetSession) {
      const commitRoot = opts?.root ?? targetRoot;
      const commitRooted = commitRoot === undefined ? {} : { root: commitRoot };
      openEditorTab(
        { kind: 'commit', session: targetSession.id, path, sha, ...commitRooted },
        undefined,
        previewing(opts),
      );
    }
  };
  const openSearchFile = (path: string, line?: number, opts?: OpenOpts) => {
    if (!targetSession) return;
    const position = line !== undefined ? { line, column: 1 } : undefined;
    // A directory target's files are `external` tabs — the kind that carries a
    // root through the editor, its buffer, its drafts, and its save.
    if (targetRoot !== undefined) {
      openEditorTab(
        { kind: 'external', session: targetSession.id, path, root: targetRoot },
        position,
        previewing(opts),
      );
      return;
    }
    openFile(targetSession.id, path, position, previewing(opts));
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
  if (windowIdentity && !project && detail.error && uiState.loaded && profileId)
    return (
      <FileCloseScope state={baseUiState}>
        <ProjectRecovery
          profileId={profileId}
          snapshot={baseUiState.snapshot}
          retry={() => void detail.refetch()}
          onClose={(paneId, ref, signal) =>
            ref.type === 'editor' && ref.tab.kind === 'untitled'
              ? drafts.requestDiscard(paneId, ref, signal)
              : closeRecoveredFile(baseUiState, paneId, ref)
          }
        />
        {drafts.dialogs}
      </FileCloseScope>
    );
  // The gate needs the project ROW, not its detail: within a profile the row is
  // already in hand when the URL changes, so switching projects renders straight
  // into the new one (its session list arriving a beat later) instead of
  // replacing the workspace with a spinner.
  if (!uiState.loaded || !project || !chunksReady) {
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
      repoId={project.repo_id}
      sessions={sessions}
      target={sidebarTarget}
      browseRequest={browseRequest}
      onFiletreeRootChange={rememberFiletreeRoot}
      compilableExtensions={compilation.extensions}
      onOpenCompilationSettings={compilation.openSettings}
      onOpenFile={openTreeFile}
      onOpenExternalFile={openExternalFile}
      onOpenTerminalIn={openTerminalIn}
      activeFilePath={activeFilePath}
      activeExternalTab={activeExternalTab}
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
      searching={searchingSessions}
      setSearching={setSearchingSessions}
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
      onArchiveDrop={sidebarSessionSelection.onArchive}
      selection={sidebarSessionSelection}
      projectActions={projectActions}
    />
  );

  // Free-form tiling area (SPEC §8): editor and terminal tabs live in a
  // recursive split tree (`layout_tree`); every open terminal is kept mounted
  // by `KeepAliveHost` and its DOM adopted into whichever pane shows it, so
  // PTYs never drop. A session's resume button and ports overlay the
  // bottom-right of ITS OWN pane (PaneSessionOverlay). The DnD context wraps
  // the WHOLE workspace (not just this area) so a strip drag can land on the
  // sidebar's archive targets.
  const phoneSession =
    sessions.find((session) => session.id === phoneSelection)?.id ??
    sessions.find((session) => session.id === activeSessionId)?.id ??
    null;
  const mainArea = isNarrow ? (
    <LocalPhonePane sessions={sessions} selected={phoneSession} select={selectPhoneSession} />
  ) : (
    <div className="flex h-full flex-col bg-ground">
      {compilation.watchers}
      <ContentMotion
        className="min-h-0 flex-1"
        motionKey={JSON.stringify([
          scopeKey,
          uiState.snapshot.layout_ref,
          allLeaves(layout.tree).map((leaf) => leaf.id),
        ])}
      >
        <TileTree
          tree={layout.tree}
          filetreeRoot={filetreeRoot ?? targetRoot ?? targetSession?.worktree_path ?? null}
          sessions={tabSessions}
          reveal={reveal}
          onActivateTab={onActivateTab}
          onCloseTab={onCloseTab}
          onPromoteTab={promoteTab}
          onArchived={closeTab}
          onFocusLeaf={focusLeaf}
          onScrollDrive={claimScrollDriver}
          onResize={layout.resize}
          onDropTab={onDropTab}
          onSetTabView={layout.setView}
          compilableExtensions={compilation.extensions}
          compilationProviders={compilation.providers}
          compilationRunningKeys={compilation.runningKeys}
          onRunCompilation={(leafId, tab, copy) => void compilation.run(leafId, tab, copy)}
          onSetCompilationMode={compilation.setMode}
          onOpenCompilationSettings={compilation.openSettings}
          onRevealPreviewSource={revealPreviewSource}
          onRevealCompiledSource={revealCompiledSource}
          onNewUntitled={() => void drafts.create()}
          onRevealFile={revealFileTab}
          onRenameFile={renameFileTab}
          focusedLeafId={layout.focusedLeaf.id}
          scrollDriverLeafId={scrollDriverLeafId}
          scrollChannel={`${profileId ?? ''}:${scopeKey}`}
        />
      </ContentMotion>
    </div>
  );

  // KeepAliveHost wraps BOTH layouts: crossing the breakpoint (a tablet
  // rotation, a resized window) swaps the shell without remounting it, so
  // open terminals keep their scrollback and PTY attachments. Under
  // project-based layout it also holds the OTHER projects' terminals (parked,
  // detached) so switching project parks them instead of rebuilding them.
  const workspace = (
    <KeepAliveHost
      tree={layout.tree}
      parked={[...parkedSessions, ...phoneVisited, ...(phoneSession ? [phoneSession] : [])]}
      onOpenFile={openFromTerminal}
    >
      <TilingDnd
        onDrop={layout.drop}
        onDropPane={layout.dropPane}
        onArchive={(id) => sidebarSessionSelection.onArchive([id])}
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
            <div className="rounded-md bg-elevated px-2.5 py-1 text-xs text-fg shadow-lg">
              {label}
            </div>
          );
        }}
      >
        <div className="relative flex h-full min-h-0 gap-[var(--ui-surface-gap)] overflow-hidden p-[var(--ui-surface-gap)]">
          {paneWindow ? (
            <div className="min-w-0 flex-1">{mainArea}</div>
          ) : isNarrow ? (
            /* Narrow (SPEC §12): both rails stay put; expanding opens the sidebar
             as an overlay above the tiling area — a translucent ground dims
             what stays behind (HUMANS.md transparency, no borders). */
            <>
              <CollapsedSidebarRail
                mode={sidebarMode}
                onExpand={() => animateSidebar(() => setNarrowNav(true))}
                onSelect={(m) => {
                  uiState.update({ sidebar_mode: m });
                  animateSidebar(() => setNarrowNav(true));
                }}
              />
              <div className="min-w-0 flex-1">{mainArea}</div>
              <CollapsedSessionsRail
                groups={sessionGroups}
                accounts={accounts}
                activeSessionId={activeSessionId}
                onReorder={persistReorder}
                onPromote={(id) => layout.ensureTerminal(id)}
                onExpand={() => animateSidebar(() => setNarrowSessions(true))}
                onSearch={() => {
                  setSearchingSessions(true);
                  animateSidebar(() => setNarrowSessions(true));
                }}
                onNewTerminal={() => openCreate('terminal')}
                onNewSession={() => openCreate('agent')}
                onArchived={closeTab}
                onArchiveDrop={sidebarSessionSelection.onArchive}
                selection={sidebarSessionSelection}
                projectActions={projectActions}
              />
              {narrowNav && (
                <>
                  <button
                    type="button"
                    aria-label="Close the navigator"
                    className="absolute inset-0 z-30 bg-ground/60"
                    onClick={() => animateSidebar(() => setNarrowNav(false))}
                  />
                  <div
                    style={{ viewTransitionName: 'workspace-navigator' }}
                    className="absolute inset-y-1.5 left-11 z-40 w-[min(20rem,calc(100%-4.5rem))] shadow-xl"
                  >
                    {navigatorPanel(() => animateSidebar(() => setNarrowNav(false)))}
                  </div>
                </>
              )}
              {narrowSessions && (
                <>
                  <button
                    type="button"
                    aria-label="Close the session list"
                    className="absolute inset-0 z-30 bg-ground/60"
                    onClick={() => animateSidebar(() => setNarrowSessions(false))}
                  />
                  <div
                    style={{ viewTransitionName: 'workspace-sessions' }}
                    className="absolute inset-y-1.5 right-11 z-40 w-[min(20rem,calc(100%-4.5rem))] shadow-xl"
                  >
                    {sessionsPanel(() => animateSidebar(() => setNarrowSessions(false)))}
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              {sidebarCollapsed && (
                <div
                  className="flex h-full shrink-0"
                  style={{ viewTransitionName: 'workspace-navigator' }}
                >
                  <CollapsedSidebarRail
                    mode={sidebarMode}
                    onExpand={() =>
                      animateSidebar(() => uiState.update({ sidebar_collapsed: false }))
                    }
                    onSelect={(m) =>
                      animateSidebar(() =>
                        uiState.update({ sidebar_collapsed: false, sidebar_mode: m }),
                      )
                    }
                  />
                </div>
              )}
              <Group
                orientation="horizontal"
                className="h-full min-w-0 flex-1"
                defaultLayout={horizontalLayout}
                onLayoutChanged={mergeLayout}
              >
                {!sidebarCollapsed && (
                  <>
                    <Panel
                      id="nav"
                      defaultSize={280}
                      minSize={200}
                      maxSize={560}
                      style={{ viewTransitionName: 'workspace-navigator' }}
                    >
                      {navigatorPanel(() =>
                        animateSidebar(() => uiState.update({ sidebar_collapsed: true })),
                      )}
                    </Panel>
                    <IslandSeparator className="workspace-divider-vertical" />
                  </>
                )}
                <Panel id="main">
                  <div data-sidebar-main className="h-full w-full">
                    {mainArea}
                  </div>
                </Panel>
                {!sessionsCollapsed && (
                  <>
                    <IslandSeparator className="workspace-divider-vertical" />
                    <Panel
                      id="sessions"
                      defaultSize={260}
                      minSize={180}
                      maxSize={480}
                      style={{ viewTransitionName: 'workspace-sessions' }}
                    >
                      {sessionsPanel(() =>
                        animateSidebar(() => uiState.update({ sessions_collapsed: true })),
                      )}
                    </Panel>
                  </>
                )}
              </Group>
              {sessionsCollapsed && (
                <div
                  className="flex h-full shrink-0"
                  style={{ viewTransitionName: 'workspace-sessions' }}
                >
                  <CollapsedSessionsRail
                    groups={sessionGroups}
                    accounts={accounts}
                    activeSessionId={activeSessionId}
                    onReorder={persistReorder}
                    onPromote={(id) => layout.ensureTerminal(id)}
                    onExpand={() =>
                      animateSidebar(() => uiState.update({ sessions_collapsed: false }))
                    }
                    onSearch={() => {
                      setSearchingSessions(true);
                      animateSidebar(() => uiState.update({ sessions_collapsed: false }));
                    }}
                    onNewTerminal={() => openCreate('terminal')}
                    onNewSession={() => openCreate('agent')}
                    onArchived={closeTab}
                    onArchiveDrop={sidebarSessionSelection.onArchive}
                    selection={sidebarSessionSelection}
                    projectActions={projectActions}
                  />
                </div>
              )}
            </>
          )}
          <NewSessionDialog
            projectId={createTarget?.projectId ?? projectId}
            repoId={createTarget?.repoId ?? project.repo_id}
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
          {drafts.dialogs}
          {compilation.settingsDialog}
        </div>
      </TilingDnd>
    </KeepAliveHost>
  );
  return (
    <FileCloseScope state={baseUiState}>
      <NativeWindowRecovery profileId={profileId} snapshot={baseUiState.snapshot}>
        {workspace}
      </NativeWindowRecovery>
    </FileCloseScope>
  );
}
