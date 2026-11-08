import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { desktopNotificationClaimSchema, type DesktopWindowContext } from '@puddle/shared';
import type { WindowEffects } from './coordination.js';

export function registerWindowEffectsIpc(
  ipc: Pick<IpcMain, 'handle'>,
  context: (event: IpcMainInvokeEvent) => DesktopWindowContext,
  effects: WindowEffects,
) {
  ipc.handle('puddle:window-effects-status', (event) => effects.status(context(event).identity.id));
  ipc.handle('puddle:window-notification-claim', (event, value: unknown) => {
    const owner = context(event);
    if (Buffer.byteLength(JSON.stringify(value)) > 2048)
      throw new Error('Notification claim is too large');
    return effects.claimNotification(
      owner.identity.id,
      desktopNotificationClaimSchema.parse(value),
    );
  });
}
