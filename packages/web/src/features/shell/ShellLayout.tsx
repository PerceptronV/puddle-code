import { useEffect } from 'react';
import { Link, Outlet, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Command as CommandIcon, Settings, UserRound } from 'lucide-react';
import type { ProjectDetail, Session } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { openSettings, settingsSection, useHash } from '../../lib/hash-route';
import { useHostInfo, useProfiles, useProjectDetail, useRepos } from '../../lib/queries';
import { wsManager } from '../../lib/ws';
import { Suspense, lazy, useState } from 'react';
import { NewProjectDialog } from '../dashboard/NewProjectDialog';
import { CommandPalette } from '../palette/CommandPalette';
import { ProfilePanel } from '../profile/ProfilePanel';
import { useCurrentProfileId } from '../profile/profile-store';
import { NewSessionProvider, useNewSession } from './new-session-context';

// Settings (all eight sections) load only when the dialog first opens.
const SettingsDialog = lazy(() =>
  import('../settings/SettingsDialog').then((m) => ({ default: m.SettingsDialog })),
);

/** Patches live status broadcasts into every cached session list. */
function useStatusCacheSync() {
  const qc = useQueryClient();
  useEffect(() => {
    return wsManager.onStatus((event) => {
      const patch = (session: Session): Session =>
        session.id === event.session
          ? { ...session, status: event.status, last_activity_at: event.last_activity_at }
          : session;
      for (const [key, data] of qc.getQueriesData<Session[]>({ queryKey: ['sessions'] })) {
        if (data) qc.setQueryData(key, data.map(patch));
      }
      for (const [key, data] of qc.getQueriesData<ProjectDetail>({ queryKey: ['project'] })) {
        if (data) qc.setQueryData(key, { ...data, sessions: data.sessions.map(patch) });
      }
    });
  }, [qc]);
}

/**
 * scp-style location in the top-bar centre: user@host, plus :repo-path once
 * a workspace is open. The daemon reports who/where it is (/api/host) — the
 * origin (and therefore any port) never appears in the UI.
 */
function HostIndicator() {
  const host = useHostInfo();
  const params = useParams();
  const detail = useProjectDetail(params['id']);
  const repos = useRepos();
  if (!host.data) return null;

  const repoPath = repos.data?.find((r) => r.id === detail.data?.project.repo_id)?.path;
  const shownPath =
    repoPath && repoPath.startsWith(host.data.home)
      ? `~${repoPath.slice(host.data.home.length)}`
      : repoPath;

  return (
    <span className="absolute left-1/2 max-w-[45%] -translate-x-1/2 truncate font-mono text-sm font-semibold text-fg-secondary">
      {/* The host is the way home: click → all projects. */}
      <Link to="/" className="transition-colors hover:text-fg">
        {host.data.username}@{host.data.hostname}
      </Link>
      {shownPath && <span className="text-fg-muted">:{shownPath}</span>}
    </span>
  );
}

function TopBar() {
  const profileId = useCurrentProfileId();
  const profiles = useProfiles();
  const profile = profiles.data?.find((p) => p.id === profileId);
  const [panelOpen, setPanelOpen] = useState(false);

  return (
    // pl-5 ≈ the right side's visual inset (pr-3 + the ghost buttons' own padding).
    <header className="relative flex h-11 shrink-0 items-center gap-3 bg-surface pl-5 pr-3">
      <Link to="/" className="transition-opacity hover:opacity-70">
        <img src="/puddle.svg" alt="puddle" className="size-6" />
      </Link>
      <HostIndicator />
      <div className="ml-auto flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
              }
            >
              <CommandIcon />
              <span className="text-2xs">K</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Command palette (⌘K)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={() => openSettings()}>
              <Settings />
              <span className="sr-only">Settings</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="sm" className="font-mono" onClick={() => setPanelOpen(true)}>
          <UserRound />
          {profile?.name ?? '…'}
        </Button>
      </div>
      <ProfilePanel open={panelOpen} onOpenChange={setPanelOpen} />
    </header>
  );
}

function ShellBody() {
  useStatusCacheSync();
  const { handler } = useNewSession();
  const hash = useHash();
  const profileId = useCurrentProfileId();
  const [creatingProject, setCreatingProject] = useState(false);
  return (
    <div className="flex h-screen flex-col bg-ground">
      <TopBar />
      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
      <CommandPalette
        onNewSession={handler ?? undefined}
        onNewProject={() => setCreatingProject(true)}
      />
      {profileId !== null && (
        <NewProjectDialog
          profileId={profileId}
          open={creatingProject}
          onOpenChange={setCreatingProject}
        />
      )}
      {settingsSection(hash) !== null && (
        <Suspense fallback={null}>
          <SettingsDialog />
        </Suspense>
      )}
    </div>
  );
}

export function ShellLayout() {
  return (
    <NewSessionProvider>
      <ShellBody />
    </NewSessionProvider>
  );
}
