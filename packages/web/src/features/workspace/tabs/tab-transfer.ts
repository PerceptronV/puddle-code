import { desktopTabDragPayloadSchema, tabRefSchema, type TabRef } from '@puddle/shared';
import { desktopBridge } from '../../../lib/desktop';
import { toastError } from '../../../lib/transport/errors';
import { desktopWindowContext } from '../../windows/window-context';
import {
  decodeLocalDrag,
  encodeLocalDrag,
  isLocalDragScope,
  windowDragScope,
} from '../../windows/drag/drag-scope';

/**
 * The native-DnD payload for "something openable as a tab": file rows in the
 * explorer and session rows/dots in the right sidebar set it on drag start, and
 * the tiling panes accept it — so a drag out of a sidebar opens AND positions a
 * permanent tab through the same `dropTab` path strip drags use. Native HTML5
 * DnD (not dnd-kit) on purpose: both sources already are native draggables (the
 * tree for internal moves, the sidebar for reordering), and the two drag
 * systems cannot share one gesture.
 */
export const TAB_MIME = 'application/x-puddle-tab';

export function hasNativeTabTransfer(): boolean {
  return (
    desktopWindowContext() !== null &&
    desktopBridge()?.windows?.transfers?.beginTabDrag !== undefined
  );
}

export function encodeTabTransfer(
  ref: TabRef,
  options: { projectId?: string; paneId?: string } = {},
): string {
  const context = desktopWindowContext();
  const scope = windowDragScope();
  const bridge = context && desktopBridge()?.windows?.transfers;
  if (!scope || !context || !bridge?.beginTabDrag) return encodeLocalDrag(ref);
  const projectId =
    options.projectId ??
    (context.identity.kind !== 'host'
      ? context.identity.projectId
      : window.location.pathname.match(/^\/project\/([0-9a-f]{10})(?:\/|$)/)?.[1]);
  if (!projectId) return encodeLocalDrag(ref);
  const token = crypto.randomUUID();
  void bridge
    .beginTabDrag({ token, profileId: scope.profileId, projectId, ref, paneId: options.paneId })
    .catch(toastError);
  return JSON.stringify({ ...scope, token, ref, paneId: options.paneId });
}

/** Parse + validate a dropped payload; null for foreign or corrupt data. */
export function decodeTabTransfer(raw: string): TabRef | null {
  return decodeTabTransferDetails(raw)?.ref ?? null;
}

export function decodeTabTransferDetails(raw: string): { ref: TabRef; paneId?: string } | null {
  try {
    if (raw.length > 128 * 1024) return null;
    const native = desktopTabDragPayloadSchema.safeParse(JSON.parse(raw));
    if (native.success)
      return isLocalDragScope(native.data)
        ? { ref: native.data.ref, paneId: native.data.paneId }
        : null;
    return { ref: tabRefSchema.parse(decodeLocalDrag(raw)) };
  } catch {
    return null;
  }
}

/** Whether an in-flight drag carries a tab (readable during dragover, when the data itself is not). */
export function hasTabTransfer(types: readonly string[]): boolean {
  return types.includes(TAB_MIME);
}
