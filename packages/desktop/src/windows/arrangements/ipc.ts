import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  desktopArrangementApplyRequestSchema,
  desktopTransferReferenceSchema,
  type DesktopWindowContext,
} from '@puddle/shared';
import type { WindowLayoutApply } from './apply.js';

export function registerWindowLayoutApplyIpc(
  ipc: Pick<IpcMain, 'handle'>,
  context: (event: IpcMainInvokeEvent) => DesktopWindowContext,
  layouts: WindowLayoutApply,
): void {
  ipc.handle('puddle:window-layout-apply', async (event, value: unknown) => {
    const owner = context(event);
    if (owner.identity.kind !== 'host') throw new Error('Manage window layouts from a host window');
    if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024)
      throw new Error('Saved window arrangement is too large');
    const result = await layouts.apply(
      owner.identity.id,
      desktopArrangementApplyRequestSchema.parse(value),
    );
    context(event);
    return result;
  });
  ipc.handle('puddle:window-layout-observe', (event, value: unknown) => {
    const owner = context(event);
    if (owner.identity.kind !== 'host') throw new Error('Manage window layouts from a host window');
    if (Buffer.byteLength(JSON.stringify(value)) > 4096)
      throw new Error('Layout observation is too large');
    return layouts.observe(owner.identity.id, desktopTransferReferenceSchema.parse(value));
  });
}
