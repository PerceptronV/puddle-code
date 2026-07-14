import { useEffect } from 'react';
import { Link, Outlet, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Command as CommandIcon, Settings, UserRound } from 'lucide-react';
import type { ProjectDetail, Session } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { openSettings, settingsSection, useHash } from '../../lib/hash-route';
import { useHostInfo, useProfiles, useProjectDetail, useRepos } from '../../lib/queries';
import { wsManager } from '../../lib/ws';
import { Suspense, lazy, useState } from 'react';
import { NewProjectDialog } from '../dashboard/NewProjectDialog';
import { CommandPalette } from '../palette/CommandPalette';
import { profileStore, useCurrentProfileId } from '../profile/profile-store';
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
    <span className="absolute left-1/2 max-w-[45%] -translate-x-1/2 truncate font-mono text-xs text-fg-secondary">
      {host.data.username}@{host.data.hostname}
      {shownPath && <span className="text-fg-muted">:{shownPath}</span>}
    </span>
  );
}

function TopBar() {
  const profileId = useCurrentProfileId();
  const profiles = useProfiles();
  const profile = profiles.data?.find((p) => p.id === profileId);

  return (
    <header className="relative flex h-11 shrink-0 items-center gap-3 bg-surface px-3">
      <Link to="/" className="font-mono text-sm font-semibold text-fg hover:text-accent">
        puddle
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="font-mono">
              <UserRound />
              {profile?.name ?? '…'}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Profile</DropdownMenuLabel>
            {profiles.data?.map((p) => (
              <DropdownMenuItem
                key={p.id}
                className="font-mono"
                onSelect={() => profileStore.set(String(p.id))}
              >
                {p.name}
                {p.id === profileId && (
                  <span className="ml-auto text-2xs text-fg-muted">current</span>
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => profileStore.set(null)}>
              Switch profile…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
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
