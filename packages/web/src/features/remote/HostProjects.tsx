import { useEffect, useState } from 'react';
import { Laptop } from 'lucide-react';
import {
  versionResponseSchema,
  supportsApplicationFeature,
  releaseNotesSchema,
  type Project,
  type RemoteHost,
} from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { Disclosure } from '../../components/ui/disclosure';
import { ProjectCardContent, projectCardSurface } from '../dashboard/ProjectCardContent';
import { loadBrowserHost } from './identity-store';
import { watchPushNotifications } from './push-notifications';
import { RemoteClient } from './client';
import { serviceOrigin } from './service';
import {
  loadProjectCatalogue,
  type ProjectCatalogueView,
} from '../../lib/queries/project-catalogue';
import { reportInstalledReleaseNotes } from '../release-notes/state/queue';
import { projectListCache, remoteProjectScope } from '../../lib/queries/project-cache';

/** Catalogue readers never install a global transport or attach a terminal. */
export function HostProjects({
  host,
  account,
  disconnected,
  reconnect,
  pair,
  open,
}: {
  host: RemoteHost;
  account: string;
  disconnected: boolean;
  reconnect(): void;
  pair(): void;
  open(project: Project): void;
}) {
  const [catalogue, setCatalogue] = useState<ProjectCatalogueView | null>(null);
  const [message, setMessage] = useState('Connecting…');
  const [needsPairing, setNeedsPairing] = useState(false);
  useEffect(() => {
    let live = true;
    let client: RemoteClient | undefined;
    let offPush: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    let loading = false;
    let cacheScope: string | undefined;
    let capabilityGeneration: string | null = null;
    let compact = false;
    let notesAt = -Infinity;
    setCatalogue(null);
    setMessage('Connecting…');
    setNeedsPairing(false);
    if (!host.online || disconnected) return;
    const refresh = async () => {
      if (!client || client.state !== 'ready' || loading) return;
      loading = true;
      const generation = client.generation;
      const current = () => live && client?.state === 'ready' && client.generation === generation;
      try {
        const read = async (path: string) => {
          const response = await client!.request('GET', path);
          if (!response.ok) throw new Error('Could not load projects. Try connecting again.');
          return response.json() as Promise<unknown>;
        };
        if (capabilityGeneration !== generation) {
          const version = versionResponseSchema.parse(await read('/api/version'));
          if (!current()) return;
          compact =
            version.remote_project_catalogue === true &&
            supportsApplicationFeature(version.protocol, { major: 28, minor: 35 });
          capabilityGeneration = generation;
        }
        await loadProjectCatalogue(read, compact, current, (view) => {
          setCatalogue(view);
          if (cacheScope) projectListCache.write(cacheScope, view.projects);
          setMessage('');
        });
        // Installation notes are secondary, infrequent metadata. Do not hold
        // navigation or catalogue refreshes behind their transfer.
        if (current() && performance.now() - notesAt > 300_000) {
          notesAt = performance.now();
          void read('/api/release-notes')
            .then((value) => {
              if (current())
                reportInstalledReleaseNotes(client!.scope, releaseNotesSchema.parse(value));
            })
            .catch(() => {});
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
          setMessage('Use the pairing QR code from desktop Settings → Remote & Sync.');
          setNeedsPairing(true);
          return;
        }
        cacheScope = remoteProjectScope(identity);
        const cached = projectListCache.read(cacheScope);
        if (cached) {
          setCatalogue({ projects: cached, paths: {}, counts: {} });
          setMessage('Refreshing projects…');
        }
        client = new RemoteClient(identity);
        offPush = watchPushNotifications(client);
        unsubscribe = client.onState(() => {
          if (!live) return;
          setNeedsPairing(client!.state === 'rejected');
          if (client!.state === 'ready') {
            void refresh();
          } else {
            if (client!.state === 'rejected' || client!.state === 'pairing') {
              setCatalogue(null);
              if (cacheScope) projectListCache.forget(cacheScope);
            } else {
              // Retain navigation, but never present old session activity as live.
              setCatalogue((previous) => previous && { ...previous, counts: {} });
            }
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
      offPush?.();
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
            {needsPairing && (
              <Button variant="secondary" onClick={pair}>
                Pair this device
              </Button>
            )}
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
                        repoPath={catalogue.paths[project.repo_id]}
                        counts={catalogue.counts[project.id]}
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
