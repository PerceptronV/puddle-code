import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels';
import { Play, TerminalSquare } from 'lucide-react';
import { toast } from 'sonner';
import type { Session } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { useExplorerTarget } from '../explorer/use-explorer-target';
import { useAccounts, useProjectDetail, useSessionAction } from '../../lib/queries';
import { useNewSession } from '../shell/new-session-context';
import { LazyTerminal } from '../terminal/LazyTerminal';
import { LazyEditorPane } from '../editor/LazyEditorPane';
import { addOrFocusTab, type EditorTab } from '../editor/editor-tabs';
import {
  EditorProvider,
  useEditorHandler,
  type EditorPosition,
  type RevealTarget,
} from './editor-context';
import { layoutForPanels } from './panel-layout';
import {
  CollapsedSidebarRail,
  NavigatorSidebar,
  normalizeSidebarMode,
  type SidebarMode,
} from './NavigatorSidebar';
import { NewSessionDialog } from './NewSessionDialog';
import { PortsStrip } from '../ports/PortsStrip';
import { CollapsedSessionsRail, SessionSidebar } from './SessionSidebar';
import { TabStrip } from './TabStrip';
import { useUiState } from './use-ui-state';

/** Inline banner over the terminal for sessions that need a nudge. */
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
 * Project workspace: session sidebar + tab strip + terminals + editor zone.
 * Tab order, active session/editor tabs, and pane sizes persist per
 * (project, client) and restore on open (SPEC §11 reload semantics). The
 * `EditorProvider` lets the file explorer (and Phase 4 terminal links) open
 * files without prop-drilling; the editor zone lives behind the lazy boundary.
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

  const uiState = useUiState(validProject ? projectId : undefined);
  const openTabs = uiState.snapshot.session_tabs;
  const [restored, setRestored] = useState(false);
  const [creating, setCreating] = useState(false);
  const [seedAccountId, setSeedAccountId] = useState<number | undefined>(undefined);
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
    (tab: EditorTab, position?: EditorPosition) => {
      uiState.update({
        editor_tabs: addOrFocusTab(uiState.snapshot.editor_tabs, tab),
        active_editor_tab: tab,
      });
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
    [uiState],
  );
  // Stable file-open handler for terminal links, the explorer, and the editor
  // context (keeps the original `(session, path, position?)` shape).
  const openFile = useCallback(
    (sessionId: string, path: string, position?: EditorPosition) =>
      openEditorTab({ kind: 'file', session: sessionId, path }, position),
    [openEditorTab],
  );
  useEditorHandler(openFile);

  // The ⌘K palette, top bar, and profile panel reuse this modal; an account
  // id seeds the picker (profile panel → session on a chosen account).
  useEffect(() => {
    setHandler((opts) => {
      setSeedAccountId(opts?.accountId);
      setCreating(true);
    });
    return () => setHandler(null);
  }, [setHandler]);

  // Restore-on-open: prune tabs whose sessions are gone, then land on the
  // stored active session unless the URL already deep-links one.
  useEffect(() => {
    if (restored || !uiState.loaded || !detail.data) return;
    setRestored(true);
    const alive = new Set(sessions.filter((s) => s.status !== 'archived').map((s) => s.id));
    const tabs = openTabs.filter((id) => alive.has(id));
    if (tabs.length !== openTabs.length) uiState.update({ session_tabs: tabs });
    const stored = uiState.snapshot.active_session;
    if (!activeSessionId && stored && alive.has(stored)) {
      void navigate(`/project/${projectId}/session/${stored}`, { replace: true });
    }
  }, [restored, uiState, detail.data, sessions, openTabs, activeSessionId, navigate, projectId]);

  // Deep links open a tab and become the stored active session.
  useEffect(() => {
    if (!restored) return;
    if (!activeSessionId) {
      justClosedActive.current = null; // close completed; the URL caught up
      return;
    }
    // Don't re-open the tab we're closing while the URL param still lags.
    if (activeSessionId === justClosedActive.current) return;
    justClosedActive.current = null;
    if (!openTabs.includes(activeSessionId)) {
      uiState.update({
        session_tabs: [...openTabs, activeSessionId],
        active_session: activeSessionId,
      });
    } else if (uiState.snapshot.active_session !== activeSessionId) {
      uiState.update({ active_session: activeSessionId });
    }
  }, [restored, activeSessionId, openTabs, uiState]);

  // waiting_input is mirrored in the tab title (SPEC §12).
  useEffect(() => {
    const waiting = sessions.filter((s) => s.status === 'waiting_input').length;
    const name = detail.data?.project.name ?? 'puddle';
    document.title = waiting > 0 ? `● ${waiting} waiting — ${name}` : `${name} — puddle`;
    return () => {
      document.title = 'puddle';
    };
  }, [sessions, detail.data?.project.name]);

  const closeTab = useCallback(
    (id: string) => {
      const wasActive = activeSessionId === id;
      if (wasActive) justClosedActive.current = id;
      uiState.update({
        session_tabs: openTabs.filter((t) => t !== id),
        ...(wasActive ? { active_session: null } : {}),
      });
      if (wasActive) void navigate(`/project/${projectId}`);
    },
    [uiState, openTabs, activeSessionId, navigate, projectId],
  );

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  // The whole left sidebar binds to one worktree: the pinned session if any,
  // otherwise the active session tab. Files, Changes, and Search all follow it
  // (SPEC §8, pin-across-tabs).
  const sidebarTarget = useExplorerTarget(sessions, activeSessionId, uiState);
  const targetSession = sidebarTarget.session;
  const editorTabs = uiState.snapshot.editor_tabs;
  const sidebarMode: SidebarMode = normalizeSidebarMode(uiState.snapshot.sidebar_mode);
  const sidebarCollapsed = uiState.snapshot.sidebar_collapsed;
  const sessionsCollapsed = uiState.snapshot.sessions_collapsed;

  // Highlight the Changes navigator entry whose uncommitted-diff tab is active.
  const activeTab = uiState.snapshot.active_editor_tab;
  const activeDiffPath =
    activeTab?.kind === 'diff' && targetSession && activeTab.session === targetSession.id
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

  // Both Groups (horizontal shell, nested vertical editor split) persist into
  // ONE flat `layout` object: panel ids never collide, so `onLayoutChanged`
  // MERGES its keys in — a plain replace would wipe the other Group's sizes.
  // Restoring goes the other way through `layoutForPanels`, which hands each
  // Group exactly its own rendered panels' entries (react-resizable-panels
  // ignores a `defaultLayout` whose key count differs from its panel count,
  // so the merged object must never be passed whole — see panel-layout.ts).
  const mergeLayout = useCallback(
    (layout: Layout) => uiState.update({ layout: { ...uiState.snapshot.layout, ...layout } }),
    [uiState],
  );
  // The nav and sessions panels join the horizontal Group only while expanded
  // (collapsed, a slim rail sits outside the Group); the editor pane joins the
  // vertical Group only while a tab is open — keeping each Group's restore
  // count exact.
  const horizontalLayout = layoutForPanels(uiState.snapshot.layout, [
    ...(sidebarCollapsed ? [] : ['nav']),
    'main',
    ...(sessionsCollapsed ? [] : ['sessions']),
  ]);
  const verticalLayout = layoutForPanels(uiState.snapshot.layout, [
    ...(editorTabs.length > 0 ? ['editor'] : []),
    'session',
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
                sessions={sessions}
                target={sidebarTarget}
                onOpenFile={openFile}
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
          {/* Vertical split (SPEC §8): the editor zone (files, diffs, browser
            preview later) sits above the agent terminals, appearing only once a
            tab is open — with no tabs the terminals take the whole height. The
            boundary drags freely. This Group's sizes share the flat `layout`
            object (see mergeLayout / layoutForPanels). */}
          <Group
            orientation="vertical"
            className="h-full"
            defaultLayout={verticalLayout}
            onLayoutChanged={mergeLayout}
          >
            {editorTabs.length > 0 && (
              <>
                <Panel id="editor" defaultSize={360} minSize={120}>
                  <LazyEditorPane uiState={uiState} sessions={sessions} reveal={reveal} />
                </Panel>
                <Separator className="h-px bg-border transition-colors hover:bg-accent data-[resizing]:bg-accent" />
              </>
            )}
            <Panel id="session" minSize={160}>
              <div className="flex h-full flex-col bg-ground">
                <TabStrip
                  tabs={openTabs}
                  sessions={sessions}
                  activeId={activeSessionId}
                  onActivate={(id) => void navigate(`/project/${projectId}/session/${id}`)}
                  onClose={closeTab}
                  onReorder={(tabs) => uiState.update({ session_tabs: tabs })}
                />
                {activeSession && <SessionBanner session={activeSession} />}
                {activeSession && (
                  <PortsStrip sessionId={activeSession.id} status={activeSession.status} />
                )}
                <div className="relative min-h-0 flex-1">
                  {/* Terminals stay mounted whichever session is active (their PTY
                    attachment must not drop); only visibility switches. Diff and
                    history now live in the left navigator, never over the
                    terminal. */}
                  {openTabs.map((id) => (
                    <div
                      key={id}
                      className={
                        id === activeSessionId ? 'absolute inset-0 py-1 pl-4 pr-2' : 'hidden'
                      }
                    >
                      <LazyTerminal
                        stream={id}
                        onOpenFile={(path, line, column) =>
                          openFile(id, path, line !== undefined ? { line, column } : undefined)
                        }
                      />
                    </div>
                  ))}
                  {!activeSessionId && (
                    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                      <TerminalSquare className="size-8 text-fg-muted" />
                      <p className="text-sm text-fg-secondary">
                        {sessions.filter((s) => s.status !== 'archived').length === 0
                          ? 'No sessions yet — press ⌘K to start one.'
                          : 'Pick a session from the sessions sidebar.'}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </Panel>
          </Group>
        </Panel>
        {!sessionsCollapsed && (
          <>
            <Separator className="w-px bg-border transition-colors hover:bg-accent data-[resizing]:bg-accent" />
            <Panel id="sessions" defaultSize={260} minSize={180} maxSize={480}>
              <SessionSidebar
                projectId={projectId}
                sessions={sessions}
                accounts={accounts}
                activeSessionId={activeSessionId}
                order={uiState.snapshot.session_order}
                onReorder={(ids) => uiState.update({ session_order: ids })}
                onNewSession={() => setCreating(true)}
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
          seedAccountId={seedAccountId}
          onOpenChange={setCreating}
          onCreated={(session) => void navigate(`/project/${projectId}/session/${session.id}`)}
        />
      </Group>
      {sessionsCollapsed && (
        <CollapsedSessionsRail
          onExpand={() => uiState.update({ sessions_collapsed: false })}
          onNewSession={() => setCreating(true)}
        />
      )}
    </div>
  );
}
