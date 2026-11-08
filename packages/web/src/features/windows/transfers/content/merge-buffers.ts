import type { DesktopWorkspaceContent } from '@puddle/shared';
import { windowBufferKey } from '../../state/content-state';

/** A move cannot resolve two independently edited copies by choosing one silently. */
export function mergeWindowBuffers(
  destination: DesktopWorkspaceContent,
  incoming: DesktopWorkspaceContent,
) {
  const buffers = new Map(destination.buffers.map((buffer) => [windowBufferKey(buffer), buffer]));
  for (const buffer of incoming.buffers) {
    const key = windowBufferKey(buffer);
    const previous = buffers.get(key);
    if (
      previous &&
      (previous.content !== buffer.content || previous.baseMtimeMs !== buffer.baseMtimeMs)
    )
      throw new Error(`Both windows have different unsaved edits to ${buffer.path}`);
    buffers.set(key, buffer);
  }
  return [...buffers.values()];
}
