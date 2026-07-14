import { useEffect } from 'react';
import { Link, Outlet } from 'react-router';
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
import { openSettings } from '../../lib/hash-route';
import { useProfiles } from '../../lib/queries';
import { wsManager } from '../../lib/ws';
import { CommandPalette } from '../palette/CommandPalette';
import { profileStore, useCurrentProfileId } from '../profile/profile-store';
import { SettingsDialog } from '../settings/SettingsDialog';
import { NewSessionProvider, useNewSession } from './new-session-context';

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

function TopBar() {
  const profileId = useCurrentProfileId();
  const profiles = useProfiles();
  const profile = profiles.data?.find((p) => p.id === profileId);

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
      <Link to="/" className="font-mono text-sm font-semibold text-fg hover:text-accent">
        puddle
      </Link>
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
  return (
    <div className="flex h-screen flex-col bg-ground">
      <TopBar />
      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
      <CommandPalette onNewSession={handler ?? undefined} />
      <SettingsDialog />
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
