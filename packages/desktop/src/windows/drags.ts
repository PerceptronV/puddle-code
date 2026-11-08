import {
  desktopPaneDragSchema,
  desktopPaneDropSchema,
  type DesktopPaneDrag,
  type DesktopPaneDrop,
  type DesktopPaneMoveCommand,
  type DesktopWindowContext,
} from '@puddle/shared';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

/** One short-lived offer per source renderer; only a registered peer may consume it. */
export class PaneDrags {
  private readonly offers = new Map<
    string,
    { request: DesktopPaneDrag; hostId: string; expires: number }
  >();

  constructor(
    private readonly environment: {
      context(id: string): DesktopWindowContext;
      move(id: string, command: DesktopPaneMoveCommand): Promise<void>;
      now?(): number;
    },
  ) {}

  begin(sourceId: string, request: DesktopPaneDrag): void {
    const source = this.environment.context(sourceId);
    if (
      source.identity.kind !== 'pane' ||
      source.identity.profileId !== request.profileId ||
      source.identity.projectId !== request.projectId ||
      source.stagingTransfer
    )
      throw new Error('This window cannot offer that pane');
    this.offers.set(sourceId, {
      request,
      hostId: source.hostId,
      expires: this.now() + 60_000,
    });
  }

  async drop(destinationId: string, request: DesktopPaneDrop): Promise<void> {
    const offer = this.offers.get(request.sourceId);
    if (!offer || offer.request.token !== request.token || offer.expires <= this.now())
      throw new Error('The pane drag has ended; drag the pane again');
    const source = this.environment.context(request.sourceId);
    const destination = this.environment.context(destinationId);
    if (
      source.identity.kind !== 'pane' ||
      destination.identity.kind === 'pane' ||
      source.identity.id === destinationId ||
      source.stagingTransfer ||
      destination.stagingTransfer
    )
      throw new Error('Drop the pane into an available host or project window');
    if (source.hostId !== offer.hostId || source.hostId !== destination.hostId)
      throw new Error('Cannot transfer between hosts');
    if (
      request.profileId !== offer.request.profileId ||
      source.identity.profileId !== request.profileId ||
      (destination.identity.kind === 'project' &&
        (destination.identity.profileId !== request.profileId ||
          destination.identity.projectId !== request.projectId))
    )
      throw new Error('Cannot transfer between profiles or project presentations');
    // Consume before dispatch. A lost source acknowledgement cannot authorise
    // another move; the ordinary transfer coordinator records its outcome.
    this.offers.delete(request.sourceId);
    await this.environment.move(request.sourceId, {
      kind: 'move-pane',
      profileId: request.profileId,
      projectId: offer.request.projectId,
      paneId: offer.request.paneId,
      destinationId,
      destinationProjectId: request.projectId,
      placement: request.placement,
    });
  }

  disconnected(id: string): void {
    this.offers.delete(id);
  }

  private now(): number {
    return this.environment.now?.() ?? Date.now();
  }
}

export function registerPaneDragIpc(
  ipc: IpcMain,
  context: (event: IpcMainInvokeEvent) => DesktopWindowContext,
  drags: PaneDrags,
): void {
  const bounded = (value: unknown) => {
    if (Buffer.byteLength(JSON.stringify(value)) > 4096) throw new Error('Pane drag is too large');
    return value;
  };
  ipc.handle('puddle:window-begin-pane-drag', (event, value: unknown) =>
    drags.begin(context(event).identity.id, desktopPaneDragSchema.parse(bounded(value))),
  );
  ipc.handle('puddle:window-drop-pane', (event, value: unknown) =>
    drags.drop(context(event).identity.id, desktopPaneDropSchema.parse(bounded(value))),
  );
}
