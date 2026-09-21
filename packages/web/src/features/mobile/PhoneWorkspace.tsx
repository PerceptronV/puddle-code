import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Files, MoreHorizontal, SquareTerminal } from 'lucide-react';
import type { Session, SessionKind } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { browserScope } from '../../lib/browser-transport';
import { useAllSessions, useProjects, useRepos } from '../../lib/queries';
import { sessionDisplayName } from '../../lib/session-display';
import { wsManager } from '../../lib/ws';
import { ProjectCardContent, projectCardSurface } from '../dashboard/ProjectCardContent';
import { profileStore } from '../profile/profile-store';
import { NewSessionDialog } from '../workspace/NewSessionDialog';
import { MobileTerminal } from './MobileTerminal';
import { PhoneFiles } from './PhoneFiles';
import { PhoneSessionRail } from './PhoneSessionRail';
import { SessionActions } from './SessionActions';

export function PhoneWorkspace({
  connected,
  initialProject,
  hostName,
}: {
  connected: boolean;
  initialProject: string;
  hostName: string;
}) {
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState(initialProject);
  const [sessionId, setSessionId] = useState(
    () => localStorage.getItem(browserScope(`phone.session:${initialProject}`)) ?? '',
  );
  const [selectedTerm, setSelectedTerm] = useState({ session: '', term: 'agent' });
  const [view, setView] = useState<'terminals' | 'files'>('terminals');
  const [pickingProject, setPickingProject] = useState(!initialProject);
  const [creating, setCreating] = useState<SessionKind | null>(null);
  const [inspected, setInspected] = useState<Session | null>(null);
  const [attached, setAttached] = useState(wsManager.isConnected());
  const [terminals, setTerminals] = useState<Array<{ session: string; term: string }>>([]);
  const projects = useProjects(undefined);
  const sessions = useAllSessions();
  const repos = useRepos();
  const project = projects.data?.find((project) => project.id === projectId && !project.archived);
  const activeSessions =
    sessions.data?.filter(
      (session) => session.project_id === projectId && session.status !== 'archived',
    ) ?? [];
  const session = activeSessions.find((session) => session.id === sessionId) ?? activeSessions[0];
  const term = selectedTerm.session === session?.id ? selectedTerm.term : 'agent';
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['sessions'] });
  };
  useEffect(() => wsManager.onConnectionChange(setAttached), []);
  useEffect(() => {
    const changed = () => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    };
    const off = [
      wsManager.onStatus(changed),
      wsManager.onSessionsChanged(changed),
      wsManager.onRenamed(changed),
    ];
    const timer = setInterval(() => {
      if (connected && !document.hidden) changed();
    }, 10_000);
    return () => {
      off.forEach((unsubscribe) => unsubscribe());
      clearInterval(timer);
    };
  }, [qc, connected]);
  useEffect(
    () =>
      wsManager.onSessionSwitched((event) => {
        void qc.invalidateQueries({ queryKey: ['sessions'] });
        if (event.source_session !== session?.id) return;
        setProjectId(event.target_project);
        setSessionId(event.target_session);
        setView('terminals');
        localStorage.setItem(
          browserScope(`phone.session:${event.target_project}`),
          event.target_session,
        );
      }),
    [session?.id, qc],
  );
  useEffect(() => {
    if (project) profileStore.set(project.profile_id);
  }, [project]);
  useEffect(() => {
    if (!session) return;
    setTerminals((current) =>
      current.some((entry) => entry.session === session.id && entry.term === term)
        ? current
        : [...current, { session: session.id, term }],
    );
  }, [session, term]);
  const chooseProject = (id: string) => {
    setProjectId(id);
    setSessionId(localStorage.getItem(browserScope(`phone.session:${id}`)) ?? '');
    setPickingProject(false);
  };
  const choose = (next: Session) => {
    setProjectId(next.project_id);
    setSessionId(next.id);
    setSelectedTerm({ session: next.id, term: 'agent' });
    setView('terminals');
    localStorage.setItem(browserScope(`phone.session:${next.project_id}`), next.id);
  };
  const showProjects = pickingProject || !project;
  return (
    <div className="phone-workspace">
      <header className="phone-workspace-bar">
        <button
          className="flex min-w-0 items-center gap-1 text-sm font-medium hover:text-accent"
          onClick={() => setPickingProject(!pickingProject)}
          aria-label="Switch project"
        >
          <span className="truncate">{showProjects ? 'Projects' : project.name}</span>
          <ChevronDown className="size-3 shrink-0" />
        </button>
        {!showProjects && (
          <nav className="phone-view-switch" aria-label="Workspace view">
            <Button
              variant="ghost"
              aria-pressed={view === 'files'}
              onClick={() => setView('files')}
            >
              <Files />
              Files
            </Button>
            <Button
              variant="ghost"
              aria-pressed={view === 'terminals'}
              onClick={() => setView('terminals')}
            >
              <SquareTerminal />
              Terminals
            </Button>
          </nav>
        )}
      </header>
      <div className="phone-workspace-body">
        <div className="phone-centre">
          {showProjects && (
            <div className="overflow-auto p-4">
              <h2 className="mb-3 text-xs text-fg-muted">{hostName}</h2>
              <div className="grid auto-rows-fr grid-cols-1 gap-3 sm:grid-cols-2">
                {projects.data
                  ?.filter((project) => !project.archived)
                  .map((project) => (
                    <button
                      key={project.id}
                      className={projectCardSurface}
                      aria-label={`Open ${project.name}`}
                      onClick={() => chooseProject(project.id)}
                    >
                      <ProjectCardContent
                        project={project}
                        repoPath={repos.data?.find((repo) => repo.id === project.repo_id)?.path}
                        sessions={
                          sessions.data?.filter((session) => session.project_id === project.id) ??
                          []
                        }
                      />
                    </button>
                  ))}
              </div>
              {projects.isPending && <p className="phone-empty">Loading projects…</p>}
              {projects.data?.every((project) => project.archived) && (
                <p className="phone-empty">
                  No projects yet. Open a project on this host in desktop.
                </p>
              )}
            </div>
          )}
          {!showProjects && view === 'terminals' && session && (
            <div className="phone-terminal-tabs">
              {terminals
                .filter((entry) => entry.session === session.id)
                .map((entry) => (
                  <Button
                    key={entry.term}
                    variant="ghost"
                    aria-pressed={term === entry.term}
                    onClick={() => setSelectedTerm(entry)}
                    className="min-w-0 max-w-52 font-mono text-xs"
                  >
                    <span className="truncate">
                      {entry.term === 'agent' ? sessionDisplayName(session) : entry.term}
                    </span>
                  </Button>
                ))}
              <Button
                className="ml-auto shrink-0"
                variant="ghost"
                size="icon"
                aria-label="Session details"
                onClick={() => setInspected(session)}
              >
                <MoreHorizontal />
              </Button>
            </div>
          )}
          <div className="phone-view" hidden={showProjects}>
            {terminals
              .filter(
                (entry) =>
                  !sessions.data ||
                  sessions.data.some(
                    (session) => session.id === entry.session && session.status !== 'archived',
                  ),
              )
              .map((entry) => {
                const active =
                  !showProjects &&
                  view === 'terminals' &&
                  entry.session === session?.id &&
                  entry.term === term;
                return (
                  <MobileTerminal
                    key={`${entry.session}:${entry.term}`}
                    session={entry.session}
                    term={entry.term}
                    active={active}
                    connected={connected}
                    attached={attached}
                  />
                );
              })}
            {!showProjects && view === 'files' && (
              <PhoneFiles
                key={session?.id ?? projectId}
                session={session?.id}
                worktree={
                  session?.worktree_path ??
                  repos.data?.find((repo) => repo.id === project?.repo_id)?.path
                }
              />
            )}
            {!showProjects && view === 'terminals' && !session && (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-5 text-center">
                <SquareTerminal className="size-7 text-fg-muted" />
                <p className="text-sm text-fg-muted">Start something in {project.name}.</p>
                <Button
                  variant="secondary"
                  disabled={!connected}
                  onClick={() => setCreating('agent')}
                >
                  New agent
                </Button>
                <Button
                  variant="ghost"
                  disabled={!connected}
                  onClick={() => setCreating('terminal')}
                >
                  Open terminal
                </Button>
              </div>
            )}
          </div>
        </div>
        {!showProjects && (
          <PhoneSessionRail
            projects={projects.data ?? []}
            projectId={projectId}
            sessions={sessions.data ?? []}
            selected={session?.id}
            connected={connected}
            chooseProject={chooseProject}
            choose={choose}
            create={setCreating}
            inspect={setInspected}
          />
        )}
      </div>
      {(projects.error || sessions.error) && (
        <p role="alert" className="px-3 py-2 text-xs text-danger">
          {projects.error?.message || sessions.error?.message}
        </p>
      )}
      {project && creating && (
        <NewSessionDialog
          projectId={project.id}
          repoId={project.repo_id}
          open
          kind={creating}
          accountSetup="Add an agent account in desktop Settings → Accounts, then reopen this dialogue."
          onOpenChange={(open) => {
            if (!open) setCreating(null);
          }}
          onCreated={(session) => {
            choose(session);
            void refresh();
          }}
        />
      )}
      {inspected && (
        <SessionActions
          key={inspected.id}
          session={sessions.data?.find((session) => session.id === inspected.id) ?? inspected}
          connected={connected}
          attached={attached}
          close={() => setInspected(null)}
          changed={refresh}
          shell={(term) => {
            choose(inspected);
            setSelectedTerm({ session: inspected.id, term });
          }}
        />
      )}
    </div>
  );
}
