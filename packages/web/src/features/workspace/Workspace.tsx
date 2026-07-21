import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels';
import type { Session, SessionKind, TabRef } from '@puddle/shared';
import { useExplorerTarget } from '../explorer/use-explorer-target';
import { useClientSettings } from '../../lib/client-settings';
import { useSessionTitleRenderer } from '../profile/use-session-title';
import {
  useAccounts,
  useAllSessions,
  useProfileSettings,
  useProjectDetail,
  useProjects,
} from '../../lib/queries';
import { mergeOrder, orderByDrag } from './session-order';
import { useNewSession } from '../shell/new-session-context';
import type { EditorTab } from '../editor/editor-tabs';
import {
  EditorProvider,
  useEditorHandler,
  type EditorPosition,
  type RevealTarget,
} from './editor-context';
import { toast } from 'sonner';
import { warmEditorChunk } from '../editor/lazy-editor-parts';
import { warmTerminalChunk } from '../terminal/LazyTerminal';
import { wsManager } from '../../lib/ws';
import { KeepAliveHost } from './keep-alive';
import { flattenTabs, tabRefKey, type DropEdge } from './layout-tree';
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
 * — and restore on open (SPEC §11). `EditorProvider` lets the explorer and
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
  const uiState = useUiState();
  const allSessions = useAllSessions();
  const tabSessions = allSessions.data ?? sessions;

  // The right sidebar groups sessions by project (SPEC §12): the whole profile
  // in cross-project mode (client setting, default on — project order inherits
  // the homescreen's projectOrder, and the groups derive from the same
  // all-sessions list the tiling area uses), or just this project otherwise;
  // drag reorders session_order in both.
  const profileId = detail.data?.project.profile_id;
  const showAllSessions = useClientSettings().showAllProjectSessions;
  const profileProjects = useProjects(showAllSessions ? profileId : undefined);
  const profileSettings = useProfileSettings(showAllSessions ? profileId : undefined);
  const sessionGroups = useMemo<SessionGroup[]>(() => {
    const active = (s: Session) => s.status !== 'archived';
    if (!showAllSessions) {
      return [
        {
          projectId,
          name: null,
          sessions: orderByDrag(sessions.filter(active), uiState.snapshot.session_order),
        },
      ];
    }
    const ordered = orderByDrag(
      (profileProjects.data ?? []).filter((p) => !p.archived),
      profileSettings.data?.projectOrder ?? [],
    );
    const all = allSessions.data ?? sessions;
    return ordered.map((p) => ({
      projectId: p.id,
      name: p.name,
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
    profileProjects.data,
    profileSettings.data,
    allSessions.data,
  ]);
  const archivedSessions = useMemo(
    () => sessions.filter((s) => s.status === 'archived'),
    [sessions],
  );

  const layout = useLayoutTree(uiState);
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
  const [restored, setRestored] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createKind, setCreateKind] = useState<SessionKind>('agent');
  const [seedAccountId, setSeedAccountId] = useState<number | undefined>(undefined);
  const openCreate = useCallback((kind: SessionKind = 'agent') => {
    setSeedAccountId(undefined);
    setCreateKind(kind);
    setCreating(true);
  }, []);
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
    (sessionId: string, path: string, position?: EditorPosition, opts?: { preview?: boolean }) =>
      openEditorTab({ kind: 'file', session: sessionId, path }, position, opts),
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
  const promoteTab = useCallback((ref: TabRef) => layout.promote(ref), [layout]);

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
    setRestored(true);
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

  // waiting_input is mirrored in the tab title (SPEC §12).
  useEffect(() => {
    const waiting = sessions.filter((s) => s.status === 'waiting_input').length;
    const name = detail.data?.project.name ?? 'puddle';
    document.title = waiting > 0 ? `● ${waiting} waiting — ${name}` : `${name} — puddle`;
    return () => {
      document.title = 'puddle';
    };
  }, [sessions, detail.data?.project.name]);

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
  const focusedTabSession =
    focusedRef === null
      ? null
      : focusedRef.type === 'terminal'
        ? focusedRef.session
        : focusedRef.tab.session;
  const sidebarTarget = useExplorerTarget(
    tabSessions,
    focusedTabSession ?? activeSessionId,
    uiState,
  );
  const targetSession = sidebarTarget.session;
  const sidebarMode: SidebarMode = normalizeSidebarMode(uiState.snapshot.sidebar_mode);
  const sidebarCollapsed = uiState.snapshot.sidebar_collapsed;
  const sessionsCollapsed = uiState.snapshot.sessions_collapsed;
  const rightPanel = uiState.snapshot.right_panel;

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
  // New agent/terminal buttons also return the sidebar to the session list, so
  // the freshly created session is visible.
  const openCreateInSessions = useCallback(
    (kind: SessionKind) => {
      uiState.update({ right_panel: 'sessions' });
      openCreate(kind);
    },
    [uiState, openCreate],
  );

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

  return (
    <div className="flex h-full">
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
              <NavigatorSidebar
                mode={sidebarMode}
                onModeChange={(m) => uiState.update({ sidebar_mode: m })}
                onCollapse={() => uiState.update({ sidebar_collapsed: true })}
                projectId={projectId}
                repoId={detail.data.project.repo_id}
                sessions={sessions}
                target={sidebarTarget}
                onOpenFile={openTreeFile}
                activeFilePath={activeFilePath}
                activeDiffPath={activeDiffPath}
                onOpenDiff={openDiff}
                onOpenCommitFile={openCommitFile}
                onOpenSearchFile={openSearchFile}
              />
            </Panel>
            <Separator className="w-px bg-border transition-colors hover:bg-accent data-[resizing]:bg-accent" />
          </>
        )}
        <Panel id="main">
          {/* Free-form tiling area (SPEC §8): editor and terminal tabs live in a
              recursive split tree (`layout_tree`); every open terminal is kept
              mounted by `KeepAliveHost` and its DOM adopted into whichever pane
              shows it, so PTYs never drop. A session's resume button and ports
              overlay the bottom-right of ITS OWN pane (PaneSessionOverlay). */}
          <KeepAliveHost
            tree={layout.tree}
            onOpenFile={(session, path, line, column) =>
              openFile(session, path, line !== undefined ? { line, column } : undefined)
            }
          >
            <div className="flex h-full flex-col bg-ground">
              <div className="min-h-0 flex-1">
                <TilingDnd
                  onDrop={layout.drop}
                  renderOverlay={(ref) => {
                    const s =
                      ref.type === 'terminal'
                        ? tabSessions.find((x) => x.id === ref.session)
                        : undefined;
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
                  />
                </TilingDnd>
              </div>
            </div>
          </KeepAliveHost>
        </Panel>
        {!sessionsCollapsed && (
          <>
            <Separator className="w-px bg-border transition-colors hover:bg-accent data-[resizing]:bg-accent" />
            <Panel id="sessions" defaultSize={260} minSize={180} maxSize={480}>
              <SessionSidebar
                groups={sessionGroups}
                accounts={accounts}
                activeSessionId={activeSessionId}
                onReorder={persistReorder}
                onPromote={(id) => layout.ensureTerminal(id)}
                archived={archivedSessions}
                onNewSession={() => openCreateInSessions('agent')}
                onNewTerminal={() => openCreateInSessions('terminal')}
                onCollapse={() => uiState.update({ sessions_collapsed: true })}
                onArchived={closeTab}
                rightPanel={rightPanel}
                onSelectPanel={(panel) => uiState.update({ right_panel: panel })}
                profileId={profileId ?? null}
                scratchpadProjectId={projectId}
                onInsertPrompt={insertPrompt}
              />
            </Panel>
          </>
        )}

        <NewSessionDialog
          projectId={projectId}
          repoId={detail.data.project.repo_id}
          open={creating}
          kind={createKind}
          seedAccountId={seedAccountId}
          onOpenChange={setCreating}
          onCreated={(session) => void navigate(`/project/${projectId}/session/${session.id}`)}
        />
      </Group>
      {sessionsCollapsed && (
        <CollapsedSessionsRail
          groups={sessionGroups}
          activeSessionId={activeSessionId}
          onReorder={persistReorder}
          onPromote={(id) => layout.ensureTerminal(id)}
          onExpand={() => uiState.update({ sessions_collapsed: false })}
          onNewTerminal={() => openCreateInSessions('terminal')}
          onNewSession={() => openCreateInSessions('agent')}
          onOpenScratchpad={() =>
            uiState.update({ sessions_collapsed: false, right_panel: 'scratchpad' })
          }
          onArchived={closeTab}
        />
      )}
    </div>
  );
}
