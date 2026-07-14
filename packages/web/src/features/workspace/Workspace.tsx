import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels';
import { Play, TerminalSquare } from 'lucide-react';
import { toast } from 'sonner';
import type { Session } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { useProjectDetail, useSessionAction } from '../../lib/queries';
import { useNewSession } from '../shell/new-session-context';
import { Terminal } from '../terminal/Terminal';
import { NewSessionDialog } from './NewSessionDialog';
import { SessionSidebar } from './SessionSidebar';
import { TabStrip } from './TabStrip';
import { useUiState } from './use-ui-state';

/** Inline banner over the terminal for sessions that need a nudge. */
function SessionBanner({ session }: { session: Session }) {
  const resume = useSessionAction('resume');
  if (session.status !== 'interrupted' && session.status !== 'exited') return null;
  return (
    <div className="flex items-center gap-3 border-b border-border bg-elevated px-3 py-2">
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
 * Project workspace: session sidebar + tab strip + terminals. Tab order,
 * active session, and pane sizes persist per (project, client) and restore
 * on open (SPEC §11 reload semantics).
 */
export function Workspace() {
  const params = useParams();
  const navigate = useNavigate();
  const projectId = Number(params['id']);
  const validProject = Number.isInteger(projectId) && projectId > 0;
  const activeSessionId = params['sid'] ?? null;
  const detail = useProjectDetail(validProject ? projectId : undefined);
  const sessions = useMemo(() => detail.data?.sessions ?? [], [detail.data]);

  const uiState = useUiState(validProject ? projectId : undefined);
  const openTabs = uiState.snapshot.session_tabs;
  const [restored, setRestored] = useState(false);
  const [creating, setCreating] = useState(false);
  const { setHandler } = useNewSession();

  // The ⌘K palette and top bar reuse this workspace's new-session modal.
  useEffect(() => {
    setHandler(() => setCreating(true));
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
    if (!restored || !activeSessionId) return;
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
      uiState.update({
        session_tabs: openTabs.filter((t) => t !== id),
        ...(activeSessionId === id ? { active_session: null } : {}),
      });
      if (activeSessionId === id) void navigate(`/project/${projectId}`);
    },
    [uiState, openTabs, activeSessionId, navigate, projectId],
  );

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  if (!validProject) return null;
  if (!uiState.loaded || !detail.data) {
    return <div className="flex h-full items-center justify-center text-sm text-fg-muted">…</div>;
  }

  return (
    <Group
      orientation="horizontal"
      className="h-full"
      defaultLayout={uiState.snapshot.layout as Layout}
      onLayoutChanged={(layout) => uiState.update({ layout })}
    >
      <Panel id="sidebar" defaultSize={260} minSize={180} maxSize={480}>
        <SessionSidebar
          projectId={projectId}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onNewSession={() => setCreating(true)}
          onArchived={closeTab}
        />
      </Panel>
      <Separator className="w-px bg-border transition-colors hover:bg-accent data-[resizing]:bg-accent" />
      <Panel id="main">
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
          <div className="relative min-h-0 flex-1">
            {openTabs.map((id) => (
              <div key={id} className={id === activeSessionId ? 'absolute inset-0 p-1' : 'hidden'}>
                <Terminal stream={id} />
              </div>
            ))}
            {!activeSessionId && (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <TerminalSquare className="size-8 text-fg-muted" />
                <p className="text-sm text-fg-secondary">
                  {sessions.filter((s) => s.status !== 'archived').length === 0
                    ? 'No sessions yet — press ⌘K to start one.'
                    : 'Pick a session from the sidebar.'}
                </p>
              </div>
            )}
          </div>
        </div>
      </Panel>

      <NewSessionDialog
        projectId={projectId}
        repoId={detail.data.project.repo_id}
        open={creating}
        onOpenChange={setCreating}
        onCreated={(session) => void navigate(`/project/${projectId}/session/${session.id}`)}
      />
    </Group>
  );
}
