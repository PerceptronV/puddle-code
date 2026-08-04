import { useEffect } from 'react';
import { Link, Outlet, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Settings } from 'lucide-react';
import type { ProjectDetail, Session } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { openCommandPalette } from '../../lib/command-palette';
import { openSettings } from '../../lib/hash-route';
import { useHotkeyLabel } from '../../lib/hotkeys';
import { hostLabel, useHostInfo, useProjectDetail } from '../../lib/queries';
import { wsManager } from '../../lib/ws';
import { Suspense, lazy, useState } from 'react';
import { NewProjectDialog } from '../dashboard/NewProjectDialog';
import { CommandPalette } from '../palette/CommandPalette';
import { HotkeysHost } from './HotkeysHost';
import { ConnectionBanner } from './ConnectionBanner';
import { ProfilePanel } from '../profile/ProfilePanel';
import { useCurrentProfileId } from '../profile/profile-store';
import { NewSessionProvider, useNewSession } from './new-session-context';
import { UpdateBanner } from './UpdateBanner';
import { useLocalSyncEngine } from './use-local-sync-engine';
import { useWaitingNotifications } from './use-waiting-notifications';
import { ScratchpadPopover } from '../scratchpad/ScratchpadPopover';
import { LayoutsPopover } from '../layouts/LayoutsPopover';
import { desktopBridge } from '../../lib/desktop';
import { cn } from '../../lib/utils';

// Under the macOS desktop shell the native title bar is hidden and the top
// bar IS the title bar: draggable, inset on the left for the inlaid traffic
// lights (positioned by the shell at x:12 — three 12px buttons + gaps end
// around 64px, so 88px gives the host name clear air after them).
const shellTitleBar = desktopBridge() !== undefined && /Mac/.test(navigator.platform);

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
      className={cn(
        'flex shrink-0 items-center gap-2 transition-opacity hover:opacity-70',
        shellTitleBar && '[-webkit-app-region:no-drag]',
      )}
      title="All projects"
    >
      {/* Under the macOS shell the app's own chrome already says puddle —
          the title bar shows the host name alone. */}
      {!shellTitleBar && <img src="/puddle.svg" alt="puddle" className="size-4" />}
      {host.data && (
        <span className="truncate font-mono text-sm font-semibold text-fg-secondary">
          {hostLabel(host.data)}
        </span>
      )}
    </Link>
  );
}

/**
 * The centre command field (SPEC §12): a thin, background-dimmed pseudo-input
 * that opens the command palette on click. Its centred hint names the active project
 * so the bar always says where you are — no border, a fill-shift on hover
 * (HUMANS.md).
 */
function CommandField() {
  const params = useParams();
  const paletteKey = useHotkeyLabel('palette.toggle');
  const detail = useProjectDetail(params['id']);
  const projectName = detail.data?.project.name;
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      className={cn(
        'absolute left-1/2 flex h-6 w-[min(30rem,42%)] -translate-x-1/2 items-center justify-center gap-2 rounded-md bg-ground text-fg-muted transition-colors hover:bg-elevated hover:text-fg-secondary',
        shellTitleBar && '[-webkit-app-region:no-drag]',
      )}
    >
      <span className="truncate text-xs">{projectName ?? 'puddle'}</span>
      <span className="text-2xs">{paletteKey}</span>
    </button>
  );
}

function TopBar() {
  return (
    // pl-3 ≈ the right side's visual inset (pr-3 + the ghost buttons' own padding).
    <header
      className={cn(
        'relative flex h-9 shrink-0 items-center gap-3 bg-surface pl-3 pr-3',
        // Slightly taller as a title bar (40px) so the content breathes
        // without pushing the workspace chrome away from the traffic lights.
        shellTitleBar && 'h-10 pl-[88px] [-webkit-app-region:drag]',
      )}
    >
      <HomeButton />
      <CommandField />
      <div
        className={cn(
          'ml-auto flex items-center gap-1',
          shellTitleBar && '[-webkit-app-region:no-drag]',
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={() => openSettings()}>
              <Settings />
              <span className="sr-only">Settings</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
        {/* Layouts, scratchpad and profile all anchor under their triggers —
            top-right, never centre stage (SPEC §11). */}
        <LayoutsPopover />
        <ScratchpadPopover />
        <ProfilePanel />
      </div>
    </header>
  );
}

function ShellBody() {
  useStatusCacheSync();
  useLocalSyncEngine();
  useWaitingNotifications();
  const { handler } = useNewSession();
  const profileId = useCurrentProfileId();
  const [creatingProject, setCreatingProject] = useState(false);
  return (
    <div className="flex h-screen flex-col bg-ground">
      <TopBar />
      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
      {/* Bottom-anchored, like the workspace's resume banner. */}
      <ConnectionBanner />
      <UpdateBanner />
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
      {/* ALWAYS mounted (like the profile panel — the reliable one): the dialog
          gates itself on the settings store, so opening is one state flip in
          one component, with no conditional-mount gate to fall out of sync.
          The chunk loads once here, behind Suspense, instead of being warmed
          separately. */}
      <Suspense fallback={null}>
        <SettingsDialog />
      </Suspense>
      <HotkeysHost />
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
