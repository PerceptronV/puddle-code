import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels';
import { Play } from 'lucide-react';
import { toast } from 'sonner';
import type { Session, SessionKind, TabRef } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { useExplorerTarget } from '../explorer/use-explorer-target';
import { useClientSettings } from '../../lib/client-settings';
import { useSessionTitleRenderer } from '../profile/use-session-title';
import {
  useAccounts,
  useProfileSessions,
  useProfileSettings,
  useProjectDetail,
  useProjects,
  useSessionAction,
} from '../../lib/queries';
import { orderByDrag } from './session-order';
import { useNewSession } from '../shell/new-session-context';
import type { EditorTab } from '../editor/editor-tabs';
import {
  EditorProvider,
  useEditorHandler,
  type EditorPosition,
  type RevealTarget,
} from './editor-context';
import { KeepAliveHost } from './keep-alive';
import { layoutForPanels } from './panel-layout';
import {
  CollapsedSidebarRail,
  NavigatorSidebar,
  normalizeSidebarMode,
  type SidebarMode,
} from './NavigatorSidebar';
import { NewSessionDialog } from './NewSessionDialog';
import { PortsStrip } from '../ports/PortsStrip';
import { CollapsedSessionsRail, SessionSidebar, type SessionGroup } from './SessionSidebar';
import { TileTree } from './TileTree';
import { TilingDnd } from './TilingDnd';
import { useLayoutTree } from './useLayoutTree';
import { useUiState } from './use-ui-state';

/** Inline banner over the tiling area for the bound session that needs a nudge. */
function SessionBanner({ session }: { session: Session }) {
  const resume = useSessionAction('resume');
  if (session.status !== 'interrupted' && session.status !== 'exited') return null;
  return (
    <div className="flex items-center gap-3 bg-elevated px-3 py-2">
      <span className="text-xs text-fg-secondary">
        {session.status === 'interrupted'
          ? 'This session was interrupted (daemon restart or crash).'
          : 'The agent process exited.'}
      </span>
      {!session.worktree_missing && (
        <Button
          size="sm"
          className="ml-auto"
          disabled={resume.isPending}
          onClick={() => resume.mutate(session.id, { onError: (e) => toast.error(e.message) })}
        >
          <Play />
          Resume
        </Button>
      )}
    </div>
  );
}

/**
 * Project workspace (SPEC §8): the left navigator, the centre free-form tiling
 * area (editor + terminal tabs in `layout_tree`, driven by `useLayoutTree`), and
 * the right session sidebar. The tiling tree and the shell sizes persist per
 * (project, client) and restore on open (SPEC §11). `EditorProvider` lets the
 * explorer and terminal links open files without prop-drilling; Monaco/xterm
 * stay behind lazy chunks (`KeepAliveHost` + the pane bodies).
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

  const uiState = useUiState(validProject ? projectId : undefined);

  // The right sidebar groups sessions by project (SPEC §12): the whole profile
  // in cross-project mode (client setting, default on — project order inherits
  // the homescreen's projectOrder), or just this project otherwise, where drag
  // reorders session_order.
  const profileId = detail.data?.project.profile_id;
  const showAllSessions = useClientSettings().showAllProjectSessions;
  const profileSessions = useProfileSessions(showAllSessions ? profileId : undefined);
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
    const all = profileSessions.data ?? [];
    return ordered.map((p) => ({
      projectId: p.id,
      name: p.name,
      sessions: all
        .filter((s) => s.project_id === p.id && active(s))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)),
    }));
  }, [
    showAllSessions,
    sessions,
    projectId,
    uiState.snapshot.session_order,
    profileProjects.data,
    profileSettings.data,
    profileSessions.data,
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

  // Restore-on-open: prune tabs whose sessions are gone from the tree, then land
  // on the stored active session unless the URL already deep-links one.
  useEffect(() => {
    if (restored || !uiState.loaded || !detail.data) return;
    setRestored(true);
    const alive = new Set(sessions.filter((s) => s.status !== 'archived').map((s) => s.id));
    layoutRef.current.pruneSessions(alive);
    const stored = uiState.snapshot.active_session;
    if (!activeSessionId && stored && alive.has(stored)) {
      void navigate(`/project/${projectId}/session/${stored}`, { replace: true });
    }
  }, [restored, uiState, detail.data, sessions, activeSessionId, navigate, projectId]);

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
  // the left sidebar binds to it. Closing a pane tab mirrors `closeTab`.
  const onActivateTab = useCallback(
    (leafId: string, ref: TabRef) => {
      layout.activate(leafId, ref);
      if (ref.type === 'terminal') void navigate(`/project/${projectId}/session/${ref.session}`);
    },
    [layout, navigate, projectId],
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

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  // The whole left sidebar binds to one worktree: the pinned session if any,
  // otherwise the active session tab. Files, Changes, and Search all follow it
  // (SPEC §8, pin-across-tabs).
  const sidebarTarget = useExplorerTarget(sessions, activeSessionId, uiState);
  const targetSession = sidebarTarget.session;
  const sidebarMode: SidebarMode = normalizeSidebarMode(uiState.snapshot.sidebar_mode);
  const sidebarCollapsed = uiState.snapshot.sidebar_collapsed;
  const sessionsCollapsed = uiState.snapshot.sessions_collapsed;

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
  if (!uiState.loaded || !detail.data) {
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
              shows it, so PTYs never drop. The URL-bound session's resume banner
              and port strip sit above the tree. */}
          <KeepAliveHost
            tree={layout.tree}
            onOpenFile={(session, path, line, column) =>
              openFile(session, path, line !== undefined ? { line, column } : undefined)
            }
          >
            <div className="flex h-full flex-col bg-ground">
              {activeSession && <SessionBanner session={activeSession} />}
              {activeSession && (
                <PortsStrip sessionId={activeSession.id} status={activeSession.status} />
              )}
              <div className="min-h-0 flex-1">
                <TilingDnd
                  onDrop={layout.drop}
                  renderOverlay={(ref) => {
                    const s =
                      ref.type === 'terminal'
                        ? sessions.find((x) => x.id === ref.session)
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
                    sessions={sessions}
                    reveal={reveal}
                    onActivateTab={onActivateTab}
                    onCloseTab={onCloseTab}
                    onPromoteTab={promoteTab}
                    onArchived={closeTab}
                    onFocusLeaf={layout.focusLeaf}
                    onResize={layout.resize}
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
                reorderable={!showAllSessions}
                onReorder={(ids) => uiState.update({ session_order: ids })}
                archived={archivedSessions}
                onNewSession={() => openCreate('agent')}
                onNewTerminal={() => openCreate('terminal')}
                onCollapse={() => uiState.update({ sessions_collapsed: true })}
                onArchived={closeTab}
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
          reorderable={!showAllSessions}
          onReorder={(ids) => uiState.update({ session_order: ids })}
          onExpand={() => uiState.update({ sessions_collapsed: false })}
          onNewTerminal={() => openCreate('terminal')}
          onNewSession={() => openCreate('agent')}
          onArchived={closeTab}
        />
      )}
    </div>
  );
}
