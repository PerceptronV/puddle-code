import { useCallback, useRef, useState } from 'react';
import { currentProfileId } from '../../profile/profile-store';
import { browserScope } from '../../../lib/transport/browser-transport';
import { huddleViews, restoreHuddleView, type HuddleView, type HuddleCamera } from './state';

/** The caller keys its editor by viewKey so retained hooks never cross pane/host identities. */
export function useHuddleView(viewKey: string) {
  const [scope] = useState(() => ({ profile: currentProfileId(), host: browserScope('') }));
  const [view, render] = useState(() => restoreHuddleView(huddleViews.get(viewKey)));
  const latest = useRef(view);
  const save = useCallback(
    (patch: Partial<HuddleView>, redraw = true) => {
      // A delayed scroll/unmount callback must not write into the next profile or host.
      if (currentProfileId() !== scope.profile || browserScope('') !== scope.host) return;
      const next = { ...latest.current, ...patch };
      latest.current = next;
      huddleViews.set(viewKey, next);
      if (redraw) render(next);
    },
    [scope, viewKey],
  );
  const rememberCamera = useCallback((camera: HuddleCamera) => save({ camera }, false), [save]);
  return { view, save, camera: latest.current.camera, rememberCamera };
}
