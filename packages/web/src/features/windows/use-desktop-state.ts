import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { uiStateSnapshotSchema, desktopTabKey } from '@puddle/shared';
import { desktopBridge } from '../../lib/desktop';
import { fetchProfileState, putProfileState } from '../../lib/queries/queries';
import { debounce } from '../../lib/debounce';
import { toastError } from '../../lib/transport/errors';
import type { UiStateHandle } from '../workspace/use-ui-state';
import { desktopContentState } from './state/content-state';
import { desktopWindowContext, suspendDesktopContent } from './window-context';
import { DesktopWorkingSet } from './state/working-set';
import { desktopProfileSeed } from './state/profile-seed';
import { registerRendererLifecycle } from './lifecycle/renderer-lifecycle';
import { fenceWindowInteraction } from './lifecycle/interaction-fence';
import { allLeaves, focusTab, tabRefKey } from '../workspace/layout/layout-tree';
import { currentProfileId } from '../profile/profile-store';
import { DestinationTransfer } from './transfers/destination-transfer';
import { ArrangementParticipant } from './arrangements/participant';
import {
  transferDock,
  transferTabIntoWindow,
  transferProjectToHost,
} from './transfers/pane-transfer';

const workingSets = new Map<string, DesktopWorkingSet>();
const empty = uiStateSnapshotSchema.parse({});
const subscribeNothing = () => () => undefined;
const loadOwner = async (profileId: string) => {
  const owner = desktopWorkingSet(profileId);
  if (!owner) throw new Error('Window working set is unavailable');
  await owner.load(async () => (await fetchProfileState(profileId))?.ui_state ?? empty);
  return owner;
};
export const arrangementParticipant = new ArrangementParticipant({
  activeProfile: currentProfileId,
  owner: loadOwner,
  read: (profileId) => desktopBridge()!.windows!.read(profileId),
  initialArrangement: () => desktopWindowContext()?.stagingArrangement,
  fence: fenceWindowInteraction,
  suspend: suspendDesktopContent,
  staging: (id) => {
    const context = desktopWindowContext();
    if (context) {
      if (id) context.stagingArrangement = id;
      else delete context.stagingArrangement;
    }
  },
  route: () => window.location.pathname,
  navigate: (route) => window.history.replaceState(null, '', route),
});
export const destinationTransfer = new DestinationTransfer({
  activeProfile: currentProfileId,
  owner: loadOwner,
  read: (profileId) => desktopBridge()!.windows!.read(profileId),
  fence: fenceWindowInteraction,
  suspend: suspendDesktopContent,
  staging: (id) => {
    const context = desktopWindowContext();
    if (context) {
      if (id) context.stagingTransfer = id;
      else delete context.stagingTransfer;
    }
  },
  route: () => window.location.pathname,
  navigate: (route) => window.history.replaceState(null, '', route),
});

/** Installed once before workspace children mount, including on the dashboard. */
export async function registerDesktopWindowLifecycle(): Promise<void> {
  const bridge = desktopBridge()?.windows?.lifecycle;
  if (!bridge) return;
  await registerRendererLifecycle(
    bridge,
    () =>
      [...workingSets.values()].map((owner) => ({
        checkpoint: () => owner.checkpoint(),
        resume: () => owner.resumeCheckpoint(),
      })),
    (active) =>
      fenceWindowInteraction(active || [...workingSets.values()].some((owner) => owner.locked())),
    toastError,
    async ({ profileId, ref }) => {
      const owner = desktopWorkingSet(profileId);
      if (!owner) throw new Error('Window working set is unavailable');
      await owner.load(async () => {
        throw new Error('Window working set is unavailable');
      });
      const tree = owner.get().layout_tree;
      const key = desktopTabKey(ref);
      const leaf =
        tree && allLeaves(tree).find((leaf) => leaf.tabs.some((tab) => desktopTabKey(tab) === key));
      const tab = leaf?.tabs.find((tab) => desktopTabKey(tab) === key);
      if (!tree || !leaf || !tab) throw new Error('The tab is no longer in this window');
      owner.update({ layout_tree: focusTab(tree, leaf.id, tabRefKey(tab)) });
    },
    (command) => destinationTransfer.command(command),
    (command) => {
      const context = desktopWindowContext();
      const owner = desktopWorkingSet(command.profileId);
      const transfers = desktopBridge()?.windows?.transfers;
      if (
        !context ||
        (command.kind === 'move-pane' &&
          (context.identity.kind !== 'pane' || context.identity.projectId !== command.projectId)) ||
        (command.kind === 'move-project' &&
          (context.identity.kind !== 'project' ||
            context.identity.projectId !== command.projectId)) ||
        (context.identity.kind !== 'host' && context.identity.profileId !== command.profileId) ||
        currentProfileId() !== command.profileId ||
        !owner?.loaded() ||
        owner.locked() ||
        !transfers
      )
        throw new Error('The dragged pane is no longer available');
      const sourceRoute = window.location.pathname.split('/session/')[0]!;
      if (command.kind === 'move-project') {
        void transferProjectToHost(
          owner,
          transfers,
          command.projectId,
          command.destinationId,
          fenceWindowInteraction,
          suspendDesktopContent,
        ).catch(toastError);
        return;
      }
      const operation =
        command.kind === 'move-tab'
          ? transferTabIntoWindow(
              owner,
              transfers,
              command.projectId,
              command.ref,
              {
                destinationId: command.destinationId,
                destinationProjectId: command.destinationProjectId,
                placement: command.placement,
              },
              fenceWindowInteraction,
              suspendDesktopContent,
              context.identity.kind === 'pane',
              command.paneId,
              sourceRoute,
            )
          : transferDock(
              owner,
              transfers,
              command.projectId,
              command.paneId,
              command.destinationId,
              fenceWindowInteraction,
              suspendDesktopContent,
              command.placement,
              command.destinationProjectId,
            );
      void operation
        .then(() => {
          if (command.kind === 'move-tab' && window.location.pathname !== sourceRoute) {
            window.history.replaceState(null, '', sourceRoute);
            window.dispatchEvent(new PopStateEvent('popstate'));
          }
        })
        .catch(toastError);
    },
    (command) => {
      void import('./navigation/project-actions')
        .then(({ handleProjectCommand }) => handleProjectCommand(command))
        .catch(toastError);
    },
    (command) => arrangementParticipant.command(command),
  );
}

export function desktopWorkingSet(profileId: string): DesktopWorkingSet | null {
  const bridge = desktopBridge()?.windows;
  if (!bridge || !desktopWindowContext()) return null;
  let workingSet = workingSets.get(profileId);
  if (!workingSet) {
    const content = desktopContentState(profileId);
    // Preserve the existing last-writer-wins seed for independent browsers. Main
    // supplies all this host's windows, including when its host window is closed.
    const seedWriter = debounce((seed: Parameters<typeof desktopProfileSeed>[0]) => {
      void putProfileState(profileId, desktopProfileSeed(seed)).catch(toastError);
    }, 2000);
    workingSet = new DesktopWorkingSet(
      profileId,
      bridge,
      content,
      toastError,
      (saved) => {
        if (saved.seed) seedWriter(saved.seed);
      },
      desktopWindowContext()?.stagingTransfer !== undefined ||
        desktopWindowContext()?.stagingArrangement !== undefined,
    );
    const owner = workingSet;
    content.subscribe(() => owner.changed());
    workingSets.set(profileId, workingSet);
  }
  return workingSet;
}

/** Desktop state is owned outside the renderer; browser persistence stays independent. */
export function useDesktopUiState(profileId: string | null): UiStateHandle | null {
  const workingSet = useMemo(() => (profileId ? desktopWorkingSet(profileId) : null), [profileId]);
  const snapshot = useSyncExternalStore(
    workingSet?.subscribe ?? subscribeNothing,
    workingSet?.get ?? (() => empty),
  );
  const loaded = useSyncExternalStore(
    workingSet?.subscribe ?? subscribeNothing,
    workingSet?.loaded ?? (() => false),
  );
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (!workingSet || !profileId) return;
    let active = true;
    void workingSet
      .load(async () => {
        if (desktopWindowContext()?.identity.kind !== 'host')
          throw new Error('This detached workspace could not be restored');
        return (await fetchProfileState(profileId))?.ui_state ?? empty;
      })
      .catch((error: unknown) => {
        if (active)
          setError(error instanceof Error ? error : new Error('Could not restore this workspace'));
      });
    return () => {
      active = false;
      void workingSet.flush().catch(toastError);
    };
  }, [workingSet, profileId]);
  if (error) throw error;
  return workingSet
    ? { loaded, snapshot, current: workingSet.get, update: (patch) => workingSet.update(patch) }
    : null;
}
