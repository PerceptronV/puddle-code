import { uiStateSnapshotSchema, type DesktopProjectCommand } from '@puddle/shared';
import { desktopBridge } from '../../../lib/desktop';
import { queryClient } from '../../../lib/queries/client';
import { fetchAllSessions, fetchProfileState } from '../../../lib/queries/queries';
import { desktopWorkingSet } from '../use-desktop-state';
import { desktopWindowContext, suspendDesktopContent } from '../window-context';
import { transferProject, transferProjectToHost } from '../transfers/pane-transfer';
import { fenceWindowInteraction } from '../lifecycle/interaction-fence';
import { currentProfileId, profileStore } from '../../profile/profile-store';

/** Native navigation uses the same notification activation marker as ordinary links. */
export function navigateProjectRoute(route: string): void {
  const session = /\/session\/([^/]+)$/.exec(route)?.[1];
  window.history.replaceState(
    {
      ...window.history.state,
      key: crypto.randomUUID(),
      usr: session ? { notificationSession: session } : null,
    },
    '',
    route,
  );
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export async function openProjectWindow(profileId: string, projectId: string): Promise<void> {
  const windows = desktopBridge()?.windows;
  if (!windows?.projects || !windows.transfers) throw new Error('Project windows are unavailable');
  if (await windows.projects.focus({ profileId, projectId })) return;
  if (desktopWindowContext()?.identity.kind !== 'host' || currentProfileId() !== profileId)
    throw new Error('The project profile changed');
  const owner = desktopWorkingSet(profileId);
  if (!owner) throw new Error('Window working set is unavailable');
  const sessions = await fetchAllSessions(queryClient);
  await owner.load(
    async () => (await fetchProfileState(profileId))?.ui_state ?? uiStateSnapshotSchema.parse({}),
  );
  if (currentProfileId() !== profileId) throw new Error('The project profile changed');
  const currentProject = /^\/project\/([0-9a-f]{10})/.exec(window.location.pathname)?.[1];
  const sourceRoute = currentProject === projectId ? '/' : window.location.pathname;
  await transferProject(
    owner,
    windows.transfers,
    windows.projects,
    projectId,
    new Map(sessions.map((session) => [session.id, session.project_id])),
    currentProject ?? projectId,
    sourceRoute,
    fenceWindowInteraction,
  );
  navigateProjectRoute(sourceRoute);
}

export async function handleProjectCommand(command: DesktopProjectCommand): Promise<void> {
  const identity = desktopWindowContext()?.identity;
  if (!identity || (identity.kind !== 'host' && identity.profileId !== command.profileId))
    throw new Error('This window belongs to another profile');
  if (identity.kind === 'host' && currentProfileId() !== command.profileId)
    profileStore.set(command.profileId);
  if (command.kind === 'navigate-project') navigateProjectRoute(command.route);
  else await openProjectWindow(command.profileId, command.projectId);
}

export async function returnProjectWindow(): Promise<void> {
  const bridge = desktopBridge();
  const identity = desktopWindowContext()?.identity;
  const transfers = bridge?.windows?.transfers;
  if (identity?.kind !== 'project' || !bridge?.closeWindow)
    throw new Error('Project return is unavailable');
  const targets =
    transfers?.prepareProjectDock && transfers.dockTargets
      ? await transfers.dockTargets(identity.profileId)
      : [];
  const host = targets.find((target) => target.identity.kind === 'host');
  if (!host) {
    bridge.closeWindow();
    return;
  }
  const owner = desktopWorkingSet(identity.profileId);
  if (!owner || !transfers) throw new Error('Window working set is unavailable');
  await transferProjectToHost(
    owner,
    transfers,
    identity.projectId,
    host.identity.id,
    fenceWindowInteraction,
    suspendDesktopContent,
  );
}
