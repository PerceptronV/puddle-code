import { useCallback, useSyncExternalStore } from 'react';
import { desktopContentState } from '../state/content-state';

export function useRetainedBuffers(profileId: string) {
  const content = desktopContentState(profileId);
  return useSyncExternalStore(
    useCallback((listener) => content.subscribe(listener), [content]),
    content.retainedBuffers,
  );
}
