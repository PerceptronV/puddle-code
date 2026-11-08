import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useEditorBuffer } from '../../editor/buffers/use-editor-buffer';
import { bufferKey, subscribe, retainModel, releaseModel } from '../../editor/buffers/buffer-store';
import { comparisonLocksBuffer } from '../../editor/conflicts/conflict-store';

/** Both huddle documents share the normal editor draft, save and conflict lifecycle. */
export function useHuddleSource(session: string, path: string, focused: boolean) {
  const buffer = useEditorBuffer(session, path, null, undefined, { focused, live: true });
  const key = bufferKey(session, path);
  useEffect(() => {
    retainModel(key);
    return () => releaseModel(key);
  }, [key]);
  const text = useSyncExternalStore(
    useCallback((listener) => subscribe(key, listener), [key]),
    () => buffer.model?.getValue() ?? '',
  );
  return {
    path,
    buffer,
    text,
    locked: buffer.status !== 'ready' || comparisonLocksBuffer(buffer.conflict),
  };
}
