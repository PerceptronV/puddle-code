import { desktopTabDragPayloadSchema, type DesktopTabDock } from '@puddle/shared';
import { desktopBridge } from '../../lib/desktop';
import { toastError } from '../../lib/transport/errors';
import { currentProfileId } from '../profile/profile-store';
import { desktopWindowContext } from './window-context';

/** Claim only cross-window drops. Local sidebar drops keep their existing action policy. */
export function dropTabWindow(
  raw: string,
  projectId: string,
  placement: DesktopTabDock['placement'],
): boolean {
  if (raw.length > 128 * 1024) return false;
  let parsed;
  try {
    parsed = desktopTabDragPayloadSchema.safeParse(JSON.parse(raw));
  } catch {
    return false;
  }
  const context = desktopWindowContext();
  if (!parsed.success || !context || parsed.data.sourceId === context.identity.id) return false;
  const payload = parsed.data;
  void (async () => {
    const bridge = desktopBridge()?.windows?.transfers;
    if (!bridge?.dropTab) throw new Error('Tab window transfers are unavailable');
    if (context.hostId !== payload.hostId) throw new Error('Cannot transfer between hosts');
    if (currentProfileId() !== payload.profileId)
      throw new Error('Cannot transfer between profiles');
    await bridge.dropTab({
      token: payload.token,
      sourceId: payload.sourceId,
      profileId: payload.profileId,
      projectId,
      placement,
    });
  })().catch(toastError);
  return true;
}
