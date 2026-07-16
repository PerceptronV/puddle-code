import { useEffect } from 'react';
import { Link, Outlet, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Settings } from 'lucide-react';
import type { ProjectDetail, Session } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { openCommandPalette } from '../../lib/command-palette';
import { openSettings, useSettingsSection } from '../../lib/hash-route';
import { useHostInfo, useProjectDetail } from '../../lib/queries';
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

/** Patches live status and rename broadcasts into every cached session list. */
function useStatusCacheSync() {
  const qc = useQueryClient();
  useEffect(() => {
    const patchAll = (patch: (s: Session) => Session) => {
      for (const [key, data] of qc.getQueriesData<Session[]>({ queryKey: ['sessions'] })) {
        if (data) qc.setQueryData(key, data.map(patch));
      }
      for (const [key, data] of qc.getQueriesData<ProjectDetail>({ queryKey: ['project'] })) {
        if (data) qc.setQueryData(key, { ...data, sessions: data.sessions.map(patch) });
      }
    };
    const offStatus = wsManager.onStatus((event) =>
      patchAll((session) =>
        session.id === event.session
          ? { ...session, status: event.status, last_activity_at: event.last_activity_at }
          : session,
      ),
    );
    const offRenamed = wsManager.onRenamed((event) =>
      patchAll((session) =>
        session.id === event.session
          ? {
              ...session,
              title: event.title,
              // Older daemons omit agent_title / osc_title from the event — keep
              // the cached value rather than wiping it.
              agent_title: 'agent_title' in event ? event.agent_title : session.agent_title,
              osc_title: 'osc_title' in event ? event.osc_title : session.osc_title,
            }
          : session,
      ),
    );
    return () => {
      offStatus();
      offRenamed();
    };
  }, [qc]);
}

/**
 * The way home: the small puddle mark and the daemon's host name, as one
 * clickable block → all projects. The host tells you which machine you're
 * driving (the daemon reports it via /api/host; the origin/port never shows).
 */
function HomeButton() {
  const host = useHostInfo();
  return (
    <Link
      to="/"
      className="flex shrink-0 items-center gap-2 transition-opacity hover:opacity-70"
      title="All projects"
    >
      <img src="/puddle.svg" alt="puddle" className="size-4" />
      {host.data && (
        <span className="truncate font-mono text-sm font-semibold text-fg-secondary">
          {host.data.hostname}
        </span>
      )}
    </Link>
  );
}

/**
 * The centre command field (SPEC §12): a thin, background-dimmed pseudo-input
 * that opens the ⌘K palette on click. Its centred hint names the active project
 * so the bar always says where you are — no border, a fill-shift on hover
 * (HUMANS.md).
 */
function CommandField() {
  const params = useParams();
  const detail = useProjectDetail(params['id']);
  const projectName = detail.data?.project.name;
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      className="absolute left-1/2 flex h-6 w-[min(30rem,42%)] -translate-x-1/2 items-center justify-center gap-2 rounded-md bg-ground text-fg-muted transition-colors hover:bg-elevated hover:text-fg-secondary"
    >
      <span className="truncate text-xs">{projectName ?? 'puddle'}</span>
      <span className="text-2xs">⌘K</span>
    </button>
  );
}

function TopBar() {
  return (
    // pl-3 ≈ the right side's visual inset (pr-3 + the ghost buttons' own padding).
    <header className="relative flex h-9 shrink-0 items-center gap-3 bg-surface pl-3 pr-3">
      <HomeButton />
      <CommandField />
      <div className="ml-auto flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={() => openSettings()}>
              <Settings />
              <span className="sr-only">Settings</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
        {/* The panel anchors under this trigger — top-right, not centred. */}
        <ProfilePanel />
      </div>
    </header>
  );
}

function ShellBody() {
  useStatusCacheSync();
  const { handler } = useNewSession();
  const settingsSection = useSettingsSection();
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
      {settingsSection !== null && (
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
