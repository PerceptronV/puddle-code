import { useSyncExternalStore } from 'react';
import type { Session } from '@puddle/shared';
import { bufferKey, listDirty, subscribeAny } from '../../editor/buffers/buffer-store';

/** Includes open script/contract drafts, not only the graph and layout models. */
export function useHuddleSourceDirty(session: Session) {
  const prefix = bufferKey(session.id, `.puddle/huddle/${session.huddle_id}/`);
  return useSyncExternalStore(
    subscribeAny,
    () => listDirty().some((key) => key.startsWith(prefix) && key.split(':').length === 2),
    () => false,
  );
}
