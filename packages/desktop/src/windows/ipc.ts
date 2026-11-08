import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  desktopWindowReadSchema,
  desktopWindowWriteSchema,
  type DesktopWindowContext,
} from '@puddle/shared';
import type { DesktopWindowState } from './persistence/state.js';

/** Keep state access bound to the registered sender; requests never choose a window or host. */
export function registerWindowStateIpc({
  ipc,
  context,
  state,
}: {
  ipc: Pick<IpcMain, 'handle'>;
  context: (event: IpcMainInvokeEvent) => DesktopWindowContext;
  state: () => DesktopWindowState;
}): void {
  ipc.handle('puddle:window-context', (event) => context(event));
  ipc.handle('puddle:window-read', (event, value: unknown) => {
    const owner = context(event);
    const request = desktopWindowReadSchema.parse(value);
    return state().readPresentation(owner.identity.id, request.profileId);
  });
  ipc.handle('puddle:window-write', (event, value: unknown) => {
    const owner = context(event);
    // Bound before recursive layout validation. Structured clone has already
    // crossed Electron, but oversized state must never enter persistence.
    if (Buffer.byteLength(JSON.stringify(value)) > 16 * 1024 * 1024)
      throw new Error('Window update is too large');
    const request = desktopWindowWriteSchema.parse(value);
    const saved = state().write(
      owner.identity.id,
      request.profileId,
      request.revision,
      request.content,
    );
    return { ...saved, seed: state().seed(owner.identity.id, request.profileId) };
  });
}
