import { randomUUID } from 'node:crypto';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  desktopArrangementCaptureRequestSchema,
  desktopArrangementCaptureSchema,
  type DesktopArrangementCapture,
  type DesktopArrangementCaptureRequest,
  type DesktopWindowContext,
} from '@puddle/shared';
import { reopenWindowId, type ReopenWindow } from '../../reopen.js';
import type { DesktopWindowState } from '../persistence/state.js';

/** Checkpoint participants together before exporting structure, then resume every survivor. */
export class WindowLayoutCapture {
  constructor(
    private readonly dependencies: {
      state(): DesktopWindowState;
      record(id: string): ReopenWindow;
      run(target: string, key: string, action: () => Promise<void>): Promise<void>;
      validate(ids: string[]): void;
      checkpoint(id: string): Promise<void>;
      resume(ids: string[]): Promise<void>;
    },
  ) {}

  async capture(
    ownerId: string,
    request: DesktopArrangementCaptureRequest,
  ): Promise<DesktopArrangementCapture> {
    const source = this.dependencies.record(ownerId);
    if (source.window?.kind !== 'host') throw new Error('Manage window layouts from a host window');
    let result: DesktopArrangementCapture | undefined;
    await this.dependencies.run(source.target, `layout-capture:${randomUUID()}`, async () => {
      const state = this.dependencies.state();
      const scope = { ...request, ownerId };
      const original = state.arrangementEntries(scope);
      const live = original
        .filter((entry) => entry.open)
        .map((entry) => reopenWindowId(entry.record));
      this.dependencies.validate(live);
      try {
        const checkpoints = await Promise.allSettled(
          live.map((id) => this.dependencies.checkpoint(id)),
        );
        const failed = checkpoints.find((checkpoint) => checkpoint.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        this.dependencies.validate(live);
        const current = state.arrangementEntries(scope);
        const membership = (entries: typeof original) =>
          JSON.stringify(
            entries.map((entry) => ({
              id: reopenWindowId(entry.record),
              identity: entry.record.window,
              open: entry.open,
              returned: entry.returnedProject,
              route: entry.record.route,
            })),
          );
        if (membership(current) !== membership(original))
          throw new Error('Windows changed during layout capture; try again');
        result = desktopArrangementCaptureSchema.parse({
          entries: current.map((entry) => {
            if (!entry.version) throw new Error('A window has not finished loading its workspace');
            return {
              identity: entry.record.window ?? { kind: 'host', id: reopenWindowId(entry.record) },
              route: entry.record.route,
              open: entry.open,
              returnedProject: entry.returnedProject,
              revision: entry.version.revision,
              snapshot: entry.version.content.snapshot,
            };
          }),
        });
        if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 * 1024)
          throw new Error('Window arrangement capture is too large');
      } finally {
        await this.dependencies.resume(live);
      }
    });
    if (!result) throw new Error('Window layout capture did not finish');
    return result;
  }
}

export function registerWindowLayoutCaptureIpc(
  ipc: Pick<IpcMain, 'handle'>,
  context: (event: IpcMainInvokeEvent) => DesktopWindowContext,
  capture: WindowLayoutCapture,
): void {
  ipc.handle('puddle:window-layout-capture', async (event, value: unknown) => {
    const owner = context(event);
    if (owner.identity.kind !== 'host') throw new Error('Manage window layouts from a host window');
    if (Buffer.byteLength(JSON.stringify(value)) > 4096)
      throw new Error('Capture request is too large');
    const request = desktopArrangementCaptureRequestSchema.parse(value);
    const result = await capture.capture(owner.identity.id, request);
    // Do not deliver a previous document's capture to a replacement renderer.
    context(event);
    return result;
  });
}
