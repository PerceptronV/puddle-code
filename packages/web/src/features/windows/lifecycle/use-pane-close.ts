import { useEffect, useRef } from 'react';
import { desktopPaneCloseReview } from '@puddle/shared';
import { desktopBridge } from '../../../lib/desktop';
import { desktopWindowContext } from '../window-context';
import { desktopWorkingSet } from '../use-desktop-state';
import { desktopContentState } from '../state/content-state';
import { cancelPaneClose, registerPaneClose } from './pane-close';
import { tabCloseKey, useRequestEditorClose } from '../../workspace/tabs/close/TabCloseRequests';
import { tabRefKey } from '../../workspace/layout/layout-tree';

/** Review one current tab at a time, then let main checkpoint and recheck all drafts. */
export function usePaneClose(profileId: string | null) {
  const request = useRequestEditorClose();
  const requestRef = useRef(request);
  requestRef.current = request;
  useEffect(() => {
    if (!profileId || desktopWindowContext()?.identity.kind !== 'pane') return;
    const owner = desktopWorkingSet(profileId);
    const offLock = owner?.subscribe(() => {
      if (owner.locked()) cancelPaneClose();
    });
    const unregister = registerPaneClose(async (signal) => {
      if (!owner?.loaded() || owner.locked()) throw new Error('This pane is not ready to close');
      const content = desktopContentState(profileId);
      while (!signal.aborted && !owner.locked()) {
        const snapshot = owner.get();
        const review = desktopPaneCloseReview({ snapshot, ...content.capture(snapshot) });
        if (review.orphaned)
          throw new Error('Recover the retained drafts before closing this pane');
        const target = review.targets[0];
        if (!target) break;
        const accepted = await requestRef.current(
          tabCloseKey(target.paneId, tabRefKey(target.ref)),
          signal,
          true,
        );
        if (!accepted || signal.aborted || owner.locked()) return;
        // Let React retire the approved tab and its portal before reviewing the next one.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      if (!signal.aborted && !owner.locked()) {
        const complete = desktopBridge()?.windows?.lifecycle?.closeReviewedPane;
        if (!complete) throw new Error('This desktop shell cannot complete pane close review');
        await complete();
      }
    });
    return () => {
      offLock?.();
      unregister();
    };
  }, [profileId]);
}
