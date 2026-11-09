import { useCallback, useSyncExternalStore } from 'react';
import type { DesktopBufferSnapshot } from '@puddle/shared';
import { desktopContentState } from '../state/content-state';

const empty: readonly DesktopBufferSnapshot[] = [];

export function useRetainedBuffers(profileId: string | null | undefined) {
  const content = profileId ? desktopContentState(profileId) : null;
  return useSyncExternalStore(
    useCallback((listener) => content?.subscribe(listener) ?? (() => {}), [content]),
    () => content?.retainedBuffers() ?? empty,
  );
}
