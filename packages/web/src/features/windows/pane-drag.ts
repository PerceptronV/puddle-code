import { desktopPaneDragPayloadSchema } from '@puddle/shared';
import { desktopBridge } from '../../lib/desktop';
import { toastError } from '../../lib/transport/errors';
import { currentProfileId } from '../profile/profile-store';
import type { DropEdge } from '../workspace/layout/layout-tree';
import { desktopWindowContext } from './window-context';

export const PANE_WINDOW_MIME = 'application/x-puddle-pane-window';

export function canDragPaneWindow(): boolean {
  return (
    desktopWindowContext()?.identity.kind === 'pane' &&
    desktopBridge()?.windows?.transfers?.beginPaneDrag !== undefined
  );
}

/** DataTransfer is writable only during dragstart, so the source mints the nonce. */
export function beginPaneWindowDrag(data: DataTransfer, paneId: string): void {
  const context = desktopWindowContext();
  const bridge = desktopBridge()?.windows?.transfers;
  if (context?.identity.kind !== 'pane' || !bridge?.beginPaneDrag)
    throw new Error('Pane dragging is unavailable');
  const token = crypto.randomUUID();
  data.setData(
    PANE_WINDOW_MIME,
    JSON.stringify({
      token,
      sourceId: context.identity.id,
      hostId: context.hostId,
      profileId: context.identity.profileId,
    }),
  );
  data.effectAllowed = 'move';
  void bridge
    .beginPaneDrag({
      token,
      profileId: context.identity.profileId,
      projectId: context.identity.projectId,
      paneId,
    })
    .catch(toastError);
}

export async function dropPaneWindow(
  raw: string,
  projectId: string,
  paneId: string,
  edge: DropEdge,
): Promise<void> {
  if (raw.length > 4096) throw new Error('Pane drag is too large');
  const payload = desktopPaneDragPayloadSchema.parse(JSON.parse(raw));
  const context = desktopWindowContext();
  const bridge = desktopBridge()?.windows?.transfers;
  if (!context || !bridge?.dropPane) throw new Error('Pane docking is unavailable');
  if (context.hostId !== payload.hostId) throw new Error('Cannot transfer between hosts');
  if (currentProfileId() !== payload.profileId) throw new Error('Cannot transfer between profiles');
  await bridge.dropPane({
    token: payload.token,
    sourceId: payload.sourceId,
    profileId: payload.profileId,
    projectId,
    // A whole pane remains a pane; a centre drop places it alongside the target.
    placement: { paneId, edge: edge === 'center' ? 'right' : edge },
  });
}
