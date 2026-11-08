import {
  desktopPaneDragSchema,
  desktopPaneDropSchema,
  desktopTabDragSchema,
  desktopTabDropSchema,
  desktopProjectDragSchema,
  desktopProjectDropSchema,
  type DesktopPaneDrag,
  type DesktopPaneDrop,
  type DesktopContentMoveCommand,
  type DesktopTabDrag,
  type DesktopTabDrop,
  type DesktopProjectDrag,
  type DesktopProjectDrop,
  type DesktopWindowContext,
} from '@puddle/shared';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
type Offer =
  | { kind: 'pane'; request: DesktopPaneDrag }
  | { kind: 'tab'; request: DesktopTabDrag }
  | { kind: 'project'; request: DesktopProjectDrag };
type Drop =
  | { kind: 'pane'; request: DesktopPaneDrop }
  | { kind: 'tab'; request: DesktopTabDrop }
  | { kind: 'project'; request: DesktopProjectDrop };

/** One short-lived offer per source renderer; only a registered peer may consume it. */
export class WindowDrags {
  private readonly offers = new Map<
    string,
    {
      offer: Offer;
      hostId: string;
      expires: number;
    }
  >();

  constructor(
    private readonly environment: {
      context(id: string): DesktopWindowContext;
      move(id: string, command: DesktopContentMoveCommand): Promise<void>;
      now?(): number;
    },
  ) {}

  beginPane(sourceId: string, request: DesktopPaneDrag): void {
    this.begin(sourceId, { kind: 'pane', request });
  }

  beginTab(sourceId: string, request: DesktopTabDrag): void {
    this.begin(sourceId, { kind: 'tab', request });
  }
  beginProject(sourceId: string, request: DesktopProjectDrag): void {
    this.begin(sourceId, { kind: 'project', request });
  }

  private begin(sourceId: string, offer: Offer): void {
    const { request } = offer;
    const source = this.environment.context(sourceId);
    if (
      (offer.kind === 'pane' &&
        (source.identity.kind !== 'pane' || source.identity.projectId !== request.projectId)) ||
      (offer.kind === 'project' &&
        (source.identity.kind !== 'project' || source.identity.projectId !== request.projectId)) ||
      (source.identity.kind !== 'host' && source.identity.profileId !== request.profileId) ||
      source.stagingTransfer ||
      source.stagingArrangement
    )
      throw new Error('This window cannot offer that pane');
    this.offers.set(sourceId, {
      offer,
      hostId: source.hostId,
      expires: this.now() + 60_000,
    });
  }

  dropPane(destinationId: string, request: DesktopPaneDrop): Promise<void> {
    return this.drop(destinationId, { kind: 'pane', request });
  }

  dropTab(destinationId: string, request: DesktopTabDrop): Promise<void> {
    return this.drop(destinationId, { kind: 'tab', request });
  }
  dropProject(destinationId: string, request: DesktopProjectDrop): Promise<void> {
    return this.drop(destinationId, { kind: 'project', request });
  }

  private async drop(destinationId: string, drop: Drop): Promise<void> {
    const { request } = drop;
    const registered = this.offers.get(request.sourceId);
    const offer = registered?.offer;
    if (
      !registered ||
      !offer ||
      offer.kind !== drop.kind ||
      offer.request.token !== request.token ||
      registered.expires <= this.now()
    )
      throw new Error('The pane drag has ended; drag the pane again');
    const source = this.environment.context(request.sourceId);
    const destination = this.environment.context(destinationId);
    if (
      (drop.kind === 'pane' &&
        (source.identity.kind !== 'pane' || destination.identity.kind === 'pane')) ||
      (drop.kind === 'project' &&
        (source.identity.kind !== 'project' || destination.identity.kind !== 'host')) ||
      source.identity.id === destinationId ||
      source.stagingTransfer ||
      destination.stagingTransfer ||
      source.stagingArrangement ||
      destination.stagingArrangement
    )
      throw new Error('Drop the pane into an available host or project window');
    if (source.hostId !== registered.hostId || source.hostId !== destination.hostId)
      throw new Error('Cannot transfer between hosts');
    if (
      request.profileId !== offer.request.profileId ||
      (source.identity.kind !== 'host' && source.identity.profileId !== request.profileId) ||
      (destination.identity.kind !== 'host' &&
        (destination.identity.profileId !== request.profileId ||
          !('projectId' in request) ||
          destination.identity.projectId !== request.projectId))
    )
      throw new Error('Cannot transfer between profiles or project presentations');
    // Consume before dispatch. A lost source acknowledgement cannot authorise
    // another move; the ordinary transfer coordinator records its outcome.
    this.offers.delete(request.sourceId);
    if (offer.kind === 'project' && drop.kind === 'project') {
      await this.environment.move(request.sourceId, {
        kind: 'move-project',
        profileId: request.profileId,
        projectId: offer.request.projectId,
        destinationId,
      });
      return;
    }
    const common = {
      profileId: request.profileId,
      projectId: offer.request.projectId,
      destinationId,
      destinationProjectId: 'projectId' in request ? request.projectId : offer.request.projectId,
    };
    if (offer.kind === 'pane' && drop.kind === 'pane')
      await this.environment.move(request.sourceId, {
        ...common,
        kind: 'move-pane',
        paneId: offer.request.paneId,
        placement: drop.request.placement,
      });
    else if (offer.kind === 'tab' && drop.kind === 'tab')
      await this.environment.move(request.sourceId, {
        ...common,
        kind: 'move-tab',
        paneId: offer.request.paneId,
        ref: offer.request.ref,
        placement: drop.request.placement,
      });
  }

  disconnected(id: string): void {
    this.offers.delete(id);
  }

  private now(): number {
    return this.environment.now?.() ?? Date.now();
  }
}

export function registerWindowDragIpc(
  ipc: IpcMain,
  context: (event: IpcMainInvokeEvent) => DesktopWindowContext,
  drags: WindowDrags,
): void {
  const bounded = (value: unknown) => {
    if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024)
      throw new Error('Window drag is too large');
    return value;
  };
  ipc.handle('puddle:window-begin-pane-drag', (event, value: unknown) =>
    drags.beginPane(context(event).identity.id, desktopPaneDragSchema.parse(bounded(value))),
  );
  ipc.handle('puddle:window-drop-pane', (event, value: unknown) =>
    drags.dropPane(context(event).identity.id, desktopPaneDropSchema.parse(bounded(value))),
  );
  ipc.handle('puddle:window-begin-tab-drag', (event, value: unknown) =>
    drags.beginTab(context(event).identity.id, desktopTabDragSchema.parse(bounded(value))),
  );
  ipc.handle('puddle:window-drop-tab', (event, value: unknown) =>
    drags.dropTab(context(event).identity.id, desktopTabDropSchema.parse(bounded(value))),
  );
  ipc.handle('puddle:window-begin-project-drag', (event, value: unknown) =>
    drags.beginProject(context(event).identity.id, desktopProjectDragSchema.parse(bounded(value))),
  );
  ipc.handle('puddle:window-drop-project', (event, value: unknown) =>
    drags.dropProject(context(event).identity.id, desktopProjectDropSchema.parse(bounded(value))),
  );
}
