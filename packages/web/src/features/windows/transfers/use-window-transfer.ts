import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { TabRef } from '@puddle/shared';
import { desktopBridge } from '../../../lib/desktop';
import { toastError } from '../../../lib/transport/errors';
import { desktopWindowContext, suspendDesktopContent } from '../window-context';
import { desktopWorkingSet, destinationTransfer } from '../use-desktop-state';
import { fenceWindowInteraction } from '../lifecycle/interaction-fence';
import { transferPane, transferTab, transferDock } from './pane-transfer';
import { useCurrentProfileId } from '../../profile/profile-store';
import { fetchProfileState } from '../../../lib/queries/queries';
import { uiStateSnapshotSchema } from '@puddle/shared';

/** The native action is absent on browsers and shells without tab-window support. */
export function useOpenTabWindow(
  ref: TabRef | null,
  options: { projectId?: string; paneId?: string } = {},
): (() => void) | undefined {
  const { id: currentProject } = useParams();
  const navigate = useNavigate();
  const profileId = useCurrentProfileId();
  const projectId = options.projectId ?? currentProject;
  const bridge = desktopBridge()?.windows?.transfers;
  if (!bridge?.focusPane || !ref || !projectId || !profileId) return undefined;
  const sourceRoute = currentProject ? `/project/${currentProject}` : '/';
  return () => {
    void (async () => {
      if (await bridge.focusPane!({ profileId, ref })) return;
      const owner = desktopWorkingSet(profileId);
      if (!owner) throw new Error('Native window state is unavailable');
      await owner.load(
        async () =>
          (await fetchProfileState(profileId))?.ui_state ?? uiStateSnapshotSchema.parse({}),
      );
      await transferTab(
        owner,
        bridge,
        projectId,
        ref,
        fenceWindowInteraction,
        options.paneId,
        sourceRoute,
      );
      await navigate(sourceRoute, { replace: true });
    })().catch(toastError);
  };
}

export async function openPaneWindow(
  profileId: string,
  projectId: string,
  paneId: string,
): Promise<void> {
  const bridge = desktopBridge()?.windows?.transfers;
  const owner = desktopWorkingSet(profileId);
  if (!bridge || !owner) throw new Error('Native pane windows are unavailable');
  await transferPane(owner, bridge, projectId, paneId, fenceWindowInteraction);
}

export async function dockPaneWindow(
  profileId: string,
  projectId: string,
  paneId: string,
  destinationId: string,
): Promise<void> {
  const bridge = desktopBridge()?.windows?.transfers;
  const owner = desktopWorkingSet(profileId);
  if (!bridge || !owner) throw new Error('Pane docking is unavailable');
  await transferDock(
    owner,
    bridge,
    projectId,
    paneId,
    destinationId,
    fenceWindowInteraction,
    suspendDesktopContent,
  );
}

let accepting: string | null = null;
/** A staged destination accepts only after the ordinary workspace has mounted its content chunks. */
export function useAcceptWindowTransfer(profileId: string | undefined, ready: boolean): void {
  useEffect(() => {
    const context = desktopWindowContext();
    const bridge = desktopBridge()?.windows?.transfers;
    if (
      !profileId ||
      !ready ||
      !context?.stagingTransfer ||
      !bridge ||
      accepting === context.stagingTransfer
    )
      return;
    const owner = desktopWorkingSet(profileId);
    if (!owner?.loaded()) return;
    const id = context.stagingTransfer;
    accepting = id;
    const accepted = bridge.accept({ id, profileId }).then(async (version) => {
      if (!(await destinationTransfer.committed(id, version))) owner.adopt(version);
      delete context.stagingTransfer;
      fenceWindowInteraction(false);
    });
    void accepted.catch(toastError);
  }, [profileId, ready]);
}
