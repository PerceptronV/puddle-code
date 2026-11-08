import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { uiStateSnapshotSchema } from '@puddle/shared';
import { desktopBridge } from '../../lib/desktop';
import { fetchProfileState, putProfileState } from '../../lib/queries/queries';
import { debounce } from '../../lib/debounce';
import { toastError } from '../../lib/transport/errors';
import type { UiStateHandle } from '../workspace/use-ui-state';
import { desktopContentState } from './content-state';
import { desktopWindowContext } from './window-context';
import { DesktopWorkingSet } from './working-set';
import { desktopProfileSeed } from './profile-seed';
import { registerRendererLifecycle } from './renderer-lifecycle';
import { fenceWindowInteraction } from './interaction-fence';

const workingSets = new Map<string, DesktopWorkingSet>();
const empty = uiStateSnapshotSchema.parse({});
const subscribeNothing = () => () => undefined;

/** Installed once before workspace children mount, including on the dashboard. */
export async function registerDesktopWindowLifecycle(): Promise<void> {
  const bridge = desktopBridge()?.windows?.lifecycle;
  if (!bridge) return;
  await registerRendererLifecycle(
    bridge,
    () => workingSets.values(),
    fenceWindowInteraction,
    toastError,
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
    workingSet = new DesktopWorkingSet(profileId, bridge, content, toastError, (saved) => {
      if (saved.seed) seedWriter(saved.seed);
    });
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
