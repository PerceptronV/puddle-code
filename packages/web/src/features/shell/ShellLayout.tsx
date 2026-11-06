import { HostPeekOverlay } from '../host/HostPeekOverlay';
import {
  HostGlyph,
  HostAppearanceTheme,
  DesktopHostIdentity,
  useHostAppearance,
} from '../host/host-appearance';
import './shell-header.css';
import { StorageBanner } from './StorageBanner';
import { useEffect } from 'react';
import { Link, Outlet, useLocation, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Settings } from 'lucide-react';
import type { Account, ProjectDetail, Session } from '@puddle/shared';
import { ErrorBoundary } from '../../components/error-boundary';
import { InlineLabelEdit, editOnDoubleClick } from '../../components/inline-label-edit';
import { ControlTray } from '../../components/ui/control-tray';
import { Button } from '../../components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { openCommandPalette } from '../../lib/navigation/command-palette';
import { toastError } from '../../lib/transport/errors';
import { openSettings } from '../../lib/navigation/hash-route';
import { useHotkeyLabel } from '../../lib/navigation/hotkeys';
import {
  hostLabel,
  useDaemonVersion,
  useHostInfo,
  usePatchConfig,
  useProjectDetail,
} from '../../lib/queries/queries';
import { daemonAnswersColourQueries } from '../../lib/transport/protocol-support';
import { cssTokenReader, onThemeChange } from '../../lib/appearance/theme';
import { wsManager } from '../../lib/transport/ws';
import { Suspense, lazy, useState } from 'react';
import { NewProjectDialog } from '../dashboard/NewProjectDialog';
import { CommandPalette } from '../palette/CommandPalette';
import { HotkeysHost } from './HotkeysHost';
import { ConnectionBanner } from './ConnectionBanner';
import { ProfilePanel } from '../profile/ProfilePanel';
import { useCurrentProfileId } from '../profile/profile-store';
import { NewSessionProvider, useNewSession } from './new-session-context';
import { UpdateToast } from './UpdateToast';
import { HostUpdateToast } from '../host-updates/HostUpdateToast';
import { HostReleaseNotes } from '../release-notes/HostReleaseNotes';
import { ReleaseNotesHost } from '../release-notes/ReleaseNotesHost';
import { useLocalSyncEngine } from './use-local-sync-engine';
import { useWaitingNotifications } from './use-waiting-notifications';
import { ScratchpadPopover } from '../scratchpad/ScratchpadPopover';
import { LayoutsPopover } from '../layouts/LayoutsPopover';
import { desktopBridge, useDesktopFullScreen } from '../../lib/desktop';
import { cn } from '../../lib/utils';
import { appearanceColourClass } from '../../lib/appearance/appearance-colours';

// Under the macOS desktop shell the native title bar is hidden and the top
// bar IS the title bar: draggable, inset on the left for the inlaid traffic
// lights (positioned by the shell at x:12 and ending at x:72; the divider
// at x:84 leaves the same 12px of space on either side).
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
    // An account's login verification lands AFTER its login PTY exits — the
    // daemon asks the agent's own auth check first, so the flag flips once the
    // dialog is already closed. The push (15.1) is what turns the settings
    // badge green without a reload.
    const offAccount = wsManager.onAccount((event) => {
      for (const [key, data] of qc.getQueriesData<Account[]>({ queryKey: ['accounts'] })) {
        if (data) {
          qc.setQueryData(
            key,
            data.map((account) =>
              account.id === event.account_id
                ? { ...account, logged_in: event.logged_in }
                : account,
            ),
          );
        }
      }
    });
    const invalidateSessions = (projectIds: string[]) => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      for (const projectId of projectIds) {
        void qc.invalidateQueries({ queryKey: ['project', projectId] });
      }
    };
    const offSessionsChanged = wsManager.onSessionsChanged((event) =>
      invalidateSessions(event.project_ids),
    );
    const offSwitched = wsManager.onSessionSwitched((event) =>
      invalidateSessions([event.target_project]),
    );
    return () => {
      offStatus();
      offRenamed();
      offAccount();
      offSessionsChanged();
      offSwitched();
    };
  }, [qc]);
}

/**
 * The way home: the chosen host glyph and the daemon's host name, as one
 * clickable block → all projects. The host tells you which machine you're
 * driving (the daemon reports it via /api/host; the origin/port never shows).
 *
 * A DOUBLE-click on the name renames the host in place — it writes the daemon's
 * `displayName` (§11 Host), the same field Settings offers — and clearing it (or
 * typing the real hostname back) unsets it, so the label falls back to the
 * hostname rather than storing it twice. As with a project header, the
 * double-click's own first click still navigates; the label is in the persistent
 * top bar, so it stays under the cursor.
 */
function HomeButton() {
  const appearance = useHostAppearance();
  const host = useHostInfo();
  const patchConfig = usePatchConfig();
  const [editing, setEditing] = useState(false);
  const label = hostLabel(host.data);

  const commit = (value: string) => {
    setEditing(false);
    const next = value.trim();
    if (next === label) return;
    patchConfig.mutate(
      { displayName: next === host.data?.hostname ? '' : next },
      { onError: (e) => toastError(e) },
    );
  };

  const mark = <HostGlyph icon={appearance.icon} />;
  const box = cn(
    'host-identity flex h-full shrink-0 items-center gap-2 px-4',
    shellTitleBar && '[-webkit-app-region:no-drag]',
  );
  const type = 'truncate font-sans text-xs font-normal';

  if (editing && label !== undefined) {
    return (
      <div className={box}>
        {mark}
        <InlineLabelEdit
          initial={host.data?.displayName ?? label}
          maxLength={64}
          className={cn(type, 'w-40')}
          onCommit={commit}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }
  return (
    <Link
      to="/"
      className={cn(box, 'hover:bg-elevated focus-visible:bg-elevated')}
      title="All projects"
    >
      {mark}
      {label !== undefined && (
        <span className={type} {...editOnDoubleClick(() => setEditing(true))}>
          {label}
        </span>
      )}
    </Link>
  );
}

/**
 * The centre command area (SPEC §12): a full-height, unfilled button
 * that opens the command palette on click. Its centred hint names the active project
 * so the bar always says where you are — no border, a fill-shift on hover
 * (HUMANS.md).
 */
function CommandField() {
  const params = useParams();
  const paletteKey = useHotkeyLabel('palette.toggle');
  const detail = useProjectDetail(params['id']);
  // The query keeps the previous project's detail while the next is in flight
  // (so the workspace under it never unmounts) — name the project in the URL or
  // nothing, never the one we just left.
  const project = detail.data?.project;
  const projectName =
    project !== undefined && project.id === params['id'] ? project.name : undefined;
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      className={cn(
        'flex h-full min-w-0 w-full cursor-pointer items-center justify-center gap-2 bg-transparent px-2 font-normal text-fg-muted transition-colors hover:bg-elevated focus-visible:bg-elevated',
        shellTitleBar && '[-webkit-app-region:no-drag]',
      )}
    >
      <span
        className={cn(
          'pointer-events-none absolute left-1/2 top-1/2 flex max-w-[40%] -translate-x-1/2 -translate-y-1/2 items-center gap-2',
          projectName && appearanceColourClass(project?.colour),
        )}
      >
        <span className="truncate text-xs">{projectName ?? 'Puddle'}</span>
        <span className="shrink-0 text-2xs">{paletteKey}</span>
      </span>
    </button>
  );
}

function TopBar() {
  const appearance = useHostAppearance();
  // macOS hides the inlaid traffic lights in full-screen, so the inset kept for
  // them would indent the host name against nothing. Full-screen therefore drops
  // the inset — the name slides to the left edge — but NOT the height: the bar is
  // 36px in every shell and every window state, so entering full-screen moves
  // the name without resizing the chrome under it. The drag region goes too —
  // there is no window to move.
  //
  // 36px is also what keeps the traffic lights centred on the host name: the
  // shell insets them at y = (36 - 14) / 2 = 11 (`main.ts`), and the name is
  // centred in the same box, so the two agree by construction. Changing this
  // height means changing `trafficLightPosition` in the same commit.
  const { fullScreen, animate } = useDesktopFullScreen();
  const inlaidLights = shellTitleBar && !fullScreen;
  return (
    <header
      data-host-colour={appearance.colour ?? undefined}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (!event.currentTarget.contains(target)) return;
        if (
          target.closest(
            '[data-header-section], [aria-label="Workspace controls"], button, a, input',
          )
        )
          return;
        openCommandPalette();
      }}
      className={cn(
        'host-header island-outline relative grid shrink-0 cursor-pointer grid-cols-[auto_1px_minmax(0,1fr)_1px_auto] items-center overflow-hidden rounded-[var(--ui-surface-radius)] bg-surface',
        'h-9',
        !shellTitleBar && 'mx-1.5 mt-1.5',
        inlaidLights && 'pl-[84px] [-webkit-app-region:drag]',
        // Only a real enter/leave animates: the padding IS the name's position,
        // so easing it slides the name between the two edges instead of
        // teleporting it. A window restored already full-screen lands with no
        // motion (see `useDesktopFullScreen`).
        animate && 'transition-[padding] duration-200 ease-out',
      )}
    >
      {inlaidLights && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-[84px] top-1/2 h-5 w-px -translate-y-1/2 bg-border"
        />
      )}
      <div
        data-header-section
        className="flex h-full min-w-0 cursor-default items-center overflow-hidden"
      >
        <HomeButton />
      </div>
      <div aria-hidden="true" className="h-5 w-px bg-border" />
      <CommandField />
      <div aria-hidden="true" className="h-5 w-px bg-border" />
      <ControlTray
        label="Workspace controls"
        className={cn(
          'shell-header-actions h-full justify-self-end rounded-none!',
          shellTitleBar && '[-webkit-app-region:no-drag]',
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="compact:h-7 compact:w-7"
              onClick={() => openSettings()}
            >
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
      </ControlTray>
    </header>
  );
}

function ShellBody() {
  useStatusCacheSync();
  useLocalSyncEngine();
  useWaitingNotifications();
  const { handler } = useNewSession();
  const profileId = useCurrentProfileId();
  const { pathname } = useLocation();
  const [creatingProject, setCreatingProject] = useState(false);
  // Report the resolved terminal colours to the daemon (protocol 14.1), which
  // answers agents' OSC 10/11 colour queries from them — the queries fire at
  // agent SPAWN, before any viewer attaches, so only the daemon reliably sees
  // them (an auto-theming agent defaulted to dark whatever the app theme).
  // Gated on a CONFIRMED >=14.1 answer, not the optimistic unknown the other
  // feature gates use: a 14.0 daemon rejects the message with an error toast.
  const version = useDaemonVersion();
  const themeToDaemon =
    version.data !== undefined && daemonAnswersColourQueries(version.data.protocol);
  useEffect(() => {
    if (!themeToDaemon) return;
    const report = () => {
      const read = cssTokenReader();
      wsManager.reportTheme(read('--text-primary'), read('--bg-base'));
    };
    report();
    return onThemeChange(report);
  }, [themeToDaemon]);
  return (
    // The cockpit owns exactly one viewport; routed views provide the scroll
    // surfaces within it. Clip any missed descendant constraint here and stop
    // a nested surface at its limit from rubber-banding the whole window.
    <div className="flex h-screen flex-col overflow-hidden overscroll-y-none bg-ground">
      <HostAppearanceTheme />
      <DesktopHostIdentity />
      <HostPeekOverlay />
      <TopBar />
      <main className="min-h-0 flex-1">
        {/* The routed view gets its OWN boundary so a crash in it leaves the top
            bar alive — the shell still navigates, and walking away from the
            broken route clears the boundary (`resetOn`, NOT a key: a key would
            remount the workspace on every session switch) with no reload. `App`
            keeps an outer one for the shell itself. */}
        <ErrorBoundary
          resetOn={pathname}
          scope={pathname.startsWith('/project/') ? 'workspace' : 'view'}
        >
          <Outlet />
        </ErrorBoundary>
      </main>
      {/* Bottom-anchored, like the workspace's resume banner. */}
      <StorageBanner />
      <ConnectionBanner />
      <UpdateToast />
      <HostUpdateToast />
      <HostReleaseNotes />
      <ReleaseNotesHost />
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
