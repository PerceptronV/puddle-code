import { useEffect, useState } from 'react';
import { Laptop } from 'lucide-react';
import {
  projectSchema,
  repoWithOrphansSchema,
  sessionSchema,
  type Project,
  type RemoteHost,
  type RepoWithOrphans,
  type Session,
} from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { Disclosure } from '../../components/ui/disclosure';
import { ProjectCardContent, projectCardSurface } from '../dashboard/ProjectCardContent';
import { loadBrowserHost } from './identity-store';
import { RemoteClient } from './client';
import { serviceOrigin } from './service';
import { loadOrderedProjects } from '../mobile/project-order';

/** Catalogue readers never install a global transport or attach a terminal. */
export function HostProjects({
  host,
  account,
  disconnected,
  reconnect,
  open,
}: {
  host: RemoteHost;
  account: string;
  disconnected: boolean;
  reconnect(): void;
  open(project: Project): void;
}) {
  const [catalogue, setCatalogue] = useState<{
    projects: Project[];
    repos: RepoWithOrphans[];
    sessions: Session[];
  } | null>(null);
  const [message, setMessage] = useState('Connecting…');
  useEffect(() => {
    let live = true;
    let client: RemoteClient | undefined;
    let unsubscribe: (() => void) | undefined;
    let loading = false;
    setCatalogue(null);
    setMessage('Connecting…');
    if (!host.online || disconnected) return;
    const refresh = async () => {
      if (!client || client.state !== 'ready' || loading) return;
      loading = true;
      try {
        const read = async (path: string) => {
          const response = await client!.request('GET', path);
          if (!response.ok) throw new Error('Could not load projects. Try connecting again.');
          return response.json() as Promise<unknown>;
        };
        const [projects, repos, sessions] = await Promise.all([
          read('/api/projects').then((value) => projectSchema.array().parse(value)),
          read('/api/repos').then((value) => repoWithOrphansSchema.array().parse(value)),
          read('/api/sessions').then((value) => sessionSchema.array().parse(value)),
        ]);
        if (live) {
          const ordered = await loadOrderedProjects(projects, read);
          if (!live) return;
          setCatalogue({ projects: ordered, repos, sessions });
          setMessage('');
        }
      } catch (error) {
        if (live) setMessage(error instanceof Error ? error.message : 'Could not load projects.');
      } finally {
        loading = false;
      }
    };
    void loadBrowserHost(serviceOrigin, account, host.id)
      .then((identity) => {
        if (!live) return;
        if (!identity) {
          setMessage('Pair this browser from Settings → Remote & Sync on your desktop.');
          return;
        }
        client = new RemoteClient(identity);
        unsubscribe = client.onState(() => {
          if (!live) return;
          if (client!.state === 'ready') void refresh();
          else {
            setCatalogue(null);
            setMessage(
              client!.state === 'rejected' ? 'Pairing required or access revoked.' : 'Connecting…',
            );
          }
        });
        client.start();
      })
      .catch((error: Error) => {
        if (live) setMessage(error.message);
      });
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 15_000);
    return () => {
      live = false;
      clearInterval(timer);
      unsubscribe?.();
      client?.close();
    };
  }, [host.id, host.online, account, disconnected]);
  return (
    <section aria-label={host.label} className="remote-host-projects">
      <Disclosure
        open
        summaryClassName="mb-3 gap-2 py-1"
        summary={
          <>
            <span>
              <Laptop className="size-4 shrink-0" />
            </span>
            <span className="text-xs font-medium">{host.label}</span>
            {(!host.online || disconnected) && (
              <span className="ml-auto text-xs">{host.online ? 'Disconnected' : 'Offline'}</span>
            )}
          </>
        }
      >
        {host.online && !disconnected ? (
          <>
            {message && <p className="py-3 text-sm text-fg-muted">{message}</p>}
            {catalogue && (
              <div className="grid auto-rows-fr grid-cols-1 gap-3 sm:grid-cols-2">
                {catalogue.projects
                  .filter((project) => !project.archived)
                  .map((project) => (
                    <button
                      key={project.id}
                      className={projectCardSurface}
                      onClick={() => open(project)}
                      aria-label={`Open ${project.name}`}
                    >
                      <ProjectCardContent
                        project={project}
                        repoPath={catalogue.repos.find((repo) => repo.id === project.repo_id)?.path}
                        sessions={catalogue.sessions.filter(
                          (session) => session.project_id === project.id,
                        )}
                      />
                    </button>
                  ))}
                {!catalogue.projects.some((project) => !project.archived) && (
                  <p className="py-3 text-sm text-fg-muted">
                    No projects yet. Open a project on this host in desktop.
                  </p>
                )}
              </div>
            )}
          </>
        ) : disconnected && host.online ? (
          <Button variant="secondary" onClick={reconnect}>
            Connect
          </Button>
        ) : (
          <p className="py-3 text-sm text-fg-muted">
            Projects will appear when this host is online.
          </p>
        )}
      </Disclosure>
    </section>
  );
}
