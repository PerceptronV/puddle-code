import { randomUUID } from 'node:crypto';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  desktopPaneDetachSchema,
  desktopPaneDockSchema,
  desktopTabDockSchema,
  desktopTransferReferenceSchema,
  desktopTransferRetireSchema,
  type DesktopPaneDetach,
  type DesktopPaneDock,
  type DesktopTabDock,
  type DesktopTransferObservation,
  type DesktopTransferReference,
  type DesktopWindowContext,
  type DesktopWindowTransfer,
  type DesktopWorkspaceVersion,
  type DesktopWindowTransferCommand,
  type DesktopTransferRetire,
} from '@puddle/shared';
import type { ReopenWindow } from '../reopen.js';
import type { DesktopWindowState } from './state.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Destination readiness may fail before it has installed an acceptance waiter.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
interface LiveTransfer {
  transfer: DesktopWindowTransfer;
  accepted: boolean;
  ready: ReturnType<typeof deferred<void>>;
  committed: ReturnType<typeof deferred<DesktopWorkspaceVersion>>;
  timer: ReturnType<typeof setTimeout>;
  existingDestination: boolean;
}
interface Planning {
  sourceId: string;
  destinationId: string;
  profileId: string;
  cancelled: boolean;
  finished: ReturnType<typeof deferred<void>>;
}

/** A destination stages first; source confirmation then makes the ownership change durable. */
export class WindowTransfers {
  private readonly live = new Map<string, LiveTransfer>();
  private readonly planning = new Map<string, Planning>();
  private readonly restoring = new Set<string>();

  presentationPending(windowId: string): boolean {
    return (
      this.restoring.has(windowId) ||
      [...this.planning.values()].some((plan) => plan.destinationId === windowId) ||
      [...this.live.values()].some(({ transfer }) => transfer.destinationId === windowId)
    );
  }

  constructor(
    private readonly dependencies: {
      state(): DesktopWindowState;
      record(id: string): ReopenWindow;
      open(record: ReopenWindow): Promise<void>;
      dismiss(id: string): void;
      report(error: unknown): void;
      committed?(): void;
      activate?(id: string): void;
      command?(
        id: string,
        command: DesktopWindowTransferCommand,
      ): Promise<DesktopWorkspaceVersion | undefined>;
      timeoutMs?: number;
    },
  ) {}

  preparePane(sourceId: string, request: DesktopPaneDetach): Promise<void> {
    const source = this.dependencies.record(sourceId);
    if (
      request.destination.snapshot.layout_tree?.kind !== 'leaf' ||
      request.destination.snapshot.layout_mode !== 'profile' ||
      Object.keys(request.destination.snapshot.project_layouts).length !== 0
    ) {
      throw new Error('A pane window requires one isolated pane');
    }
    const destination: ReopenWindow = {
      target: source.target,
      window: {
        id: `pane-${randomUUID()}`,
        kind: 'pane',
        profileId: request.profileId,
        projectId: request.projectId,
      },
      route: `/project/${request.projectId}`,
    };
    const transfer = this.dependencies.state().prepare({
      id: request.id,
      sourceId,
      destination,
      profileId: request.profileId,
      sourceRevision: request.revision,
      destinationRevision: 0,
      sourceContent: request.source,
      destinationContent: request.destination,
      closeSource: false,
      sourceRoute: request.sourceRoute ?? `/project/${request.projectId}`,
    });
    const pending = this.start(transfer, false);
    void this.dependencies
      .open(destination)
      .catch((error: unknown) => this.fail(request.id, error));
    return pending.ready.promise;
  }

  prepareDock(sourceId: string, request: DesktopPaneDock): Promise<void> {
    return this.prepareExisting(sourceId, { kind: 'pane', request });
  }

  prepareTabDock(sourceId: string, request: DesktopTabDock): Promise<void> {
    return this.prepareExisting(sourceId, { kind: 'tab', request });
  }

  private prepareExisting(
    sourceId: string,
    move: { kind: 'pane'; request: DesktopPaneDock } | { kind: 'tab'; request: DesktopTabDock },
  ): Promise<void> {
    const { request } = move;
    const source = this.dependencies.record(sourceId);
    const destination = this.dependencies.record(request.destinationId);
    if (
      (move.kind === 'pane' &&
        (source.window?.kind !== 'pane' || destination.window?.kind === 'pane')) ||
      sourceId === request.destinationId
    )
      throw new Error('Return a detached pane to a host or project window');
    if (source.target !== destination.target) throw new Error('Cannot transfer between hosts');
    if (
      (source.window?.kind !== 'host' && source.window?.profileId !== request.profileId) ||
      (destination.window?.kind !== 'host' && destination.window?.profileId !== request.profileId)
    )
      throw new Error('Cannot transfer between profiles');
    const state = this.dependencies.state();
    if (state.outcome(request.id) || this.planning.has(request.id))
      throw new Error('Transfer already recorded; inspect its outcome');
    if (state.read(sourceId, request.profileId)?.revision !== request.revision)
      throw new Error('Source workspace changed');
    for (const plan of this.planning.values()) {
      if (
        [plan.sourceId, plan.destinationId].some(
          (id) => id === sourceId || id === request.destinationId,
        )
      )
        throw new Error('A window transfer is already being prepared');
    }
    if (!this.dependencies.command) throw new Error('Docking is unavailable');
    const plan: Planning = {
      sourceId,
      destinationId: request.destinationId,
      profileId: request.profileId,
      cancelled: false,
      finished: deferred<void>(),
    };
    this.planning.set(request.id, plan);
    return this.planDock(move, destination, plan);
  }

  private async planDock(
    move: { kind: 'pane'; request: DesktopPaneDock } | { kind: 'tab'; request: DesktopTabDock },
    destination: ReopenWindow,
    plan: Planning,
  ): Promise<void> {
    const { request } = move;
    const projectId =
      destination.window && destination.window.kind !== 'host'
        ? destination.window.projectId
        : (request.destinationProjectId ?? request.projectId);
    try {
      const common = {
        transferId: request.id,
        profileId: request.profileId,
        projectId,
        content: request.destination,
      };
      const planned = await this.dependencies.command!(
        plan.destinationId,
        move.kind === 'pane'
          ? { ...common, kind: 'plan-pane', placement: move.request.placement }
          : { ...common, kind: 'plan-tab', placement: move.request.placement },
      );
      if (plan.cancelled || !planned) throw new Error('The destination plan was cancelled');
      // Recheck both live registrations after the asynchronous destination capture.
      this.dependencies.record(plan.sourceId);
      this.dependencies.record(plan.destinationId);
      const transfer = this.dependencies.state().prepare({
        id: request.id,
        sourceId: plan.sourceId,
        destination,
        profileId: request.profileId,
        sourceRevision: request.revision,
        destinationRevision: planned.revision,
        sourceContent: request.source,
        destinationContent: planned.content,
        closeSource: false,
        sourceRoute: request.sourceRoute,
        destinationRoute: `/project/${projectId}`,
      });
      const pending = this.start(transfer, true);
      this.planning.delete(request.id);
      plan.finished.resolve();
      void this.dependencies.command!(plan.destinationId, {
        kind: 'stage-window',
        transferId: request.id,
        profileId: request.profileId,
      }).catch((error: unknown) => this.fail(request.id, error));
      return pending.ready.promise;
    } catch (error) {
      try {
        this.dependencies
          .state()
          .cancelPreparation(request.id, plan.sourceId, plan.destinationId, plan.profileId);
      } finally {
        await this.dependencies.command!(plan.destinationId, {
          kind: 'cancel-window',
          transferId: request.id,
          profileId: request.profileId,
        }).catch(this.dependencies.report);
      }
      throw error;
    } finally {
      if (this.planning.get(request.id) === plan) this.planning.delete(request.id);
      plan.finished.resolve();
    }
  }

  private start(transfer: DesktopWindowTransfer, existingDestination: boolean): LiveTransfer {
    const pending: LiveTransfer = {
      transfer,
      existingDestination,
      accepted: false,
      ready: deferred<void>(),
      committed: deferred<DesktopWorkspaceVersion>(),
      timer: setTimeout(
        () => this.fail(transfer.id, new Error('The destination did not accept its pane in time')),
        this.dependencies.timeoutMs ?? 30_000,
      ),
    };
    this.live.set(transfer.id, pending);
    return pending;
  }

  accept(windowId: string, request: DesktopTransferReference): Promise<DesktopWorkspaceVersion> {
    this.assertParty(windowId, request, 'destination');
    if (this.dependencies.state().outcome(request.id) === 'committed')
      return Promise.resolve(this.version(windowId, request.profileId));
    const pending = this.live.get(request.id);
    if (!pending) throw new Error('Transfer is no longer pending');
    pending.accepted = true;
    pending.ready.resolve();
    return pending.committed.promise;
  }

  commit(windowId: string, request: DesktopTransferReference): DesktopWorkspaceVersion {
    this.assertParty(windowId, request, 'source');
    const state = this.dependencies.state();
    if (state.outcome(request.id) === 'committed') return this.version(windowId, request.profileId);
    const pending = this.live.get(request.id);
    if (!pending?.accepted) throw new Error('Destination has not accepted this transfer');
    state.commit(request.id, pending.transfer.destinationId);
    clearTimeout(pending.timer);
    this.live.delete(request.id);
    pending.committed.resolve(this.version(pending.transfer.destinationId, request.profileId));
    try {
      this.dependencies.committed?.();
      this.dependencies.activate?.(pending.transfer.destinationId);
    } catch (error) {
      this.dependencies.report(error);
    }
    return this.version(windowId, request.profileId);
  }

  observe(windowId: string, request: DesktopTransferReference): DesktopTransferObservation {
    const state = this.dependencies.state();
    const status = this.planning.has(request.id)
      ? 'prepared'
      : (state.outcome(request.id) ?? 'unknown');
    if (status !== 'unknown') this.assertParty(windowId, request, 'source');
    return { status, version: state.read(windowId, request.profileId) };
  }

  cancel(
    windowId: string,
    request: DesktopTransferReference,
  ): DesktopTransferObservation | Promise<DesktopTransferObservation> {
    this.assertParty(windowId, request, 'source');
    const plan = this.planning.get(request.id);
    if (plan) {
      plan.cancelled = true;
      this.dependencies
        .state()
        .cancelPreparation(request.id, plan.sourceId, plan.destinationId, plan.profileId);
      return plan.finished.promise.then(() => this.observe(windowId, request));
    }
    if (this.dependencies.state().outcome(request.id) === 'prepared')
      this.cancelPending(request.id, new Error('Window transfer was cancelled'));
    return this.observe(windowId, request);
  }

  disconnected(windowId: string): void {
    this.restoring.delete(windowId);
    for (const plan of this.planning.values()) {
      if (plan.sourceId === windowId || plan.destinationId === windowId) plan.cancelled = true;
    }
    for (const [id, { transfer }] of this.live) {
      if (transfer.sourceId === windowId || transfer.destinationId === windowId)
        this.fail(id, new Error('Window disconnected during the transfer'));
    }
  }

  retire(windowId: string, request: DesktopTransferRetire): void {
    this.assertParty(windowId, request, 'source');
    this.dependencies
      .state()
      .retireSource(request.id, windowId, request.profileId, request.revision);
    this.dependencies.dismiss(windowId);
  }

  private assertParty(
    windowId: string,
    request: DesktopTransferReference,
    party: 'source' | 'destination',
  ): void {
    const state = this.dependencies.state();
    const plan = this.planning.get(request.id);
    if (plan) {
      if (
        plan[party === 'source' ? 'sourceId' : 'destinationId'] !== windowId ||
        plan.profileId !== request.profileId
      )
        throw new Error('Transfer belongs to another window or profile');
      return;
    }
    if (state.transferParty(request.id, windowId) !== party)
      throw new Error('Transfer belongs to another window');
    const profile = state.transferProfile(request.id);
    if (profile && profile !== request.profileId)
      throw new Error('Transfer belongs to another profile');
  }

  private version(windowId: string, profileId: string): DesktopWorkspaceVersion {
    const version = this.dependencies.state().read(windowId, profileId);
    if (!version) throw new Error('Window working set is unavailable');
    return version;
  }

  private cancelPending(id: string, error: unknown): void {
    const pending = this.live.get(id);
    if (!pending) return;
    // Never dismiss a window until rollback is durable. A disk failure leaves
    // both copies available for explicit recovery instead of guessing ownership.
    this.dependencies.state().cancel(id);
    clearTimeout(pending.timer);
    this.live.delete(id);
    pending.ready.reject(error);
    pending.committed.reject(error);
    if (pending.existingDestination) {
      this.restoring.add(pending.transfer.destinationId);
      void this.dependencies.command!(pending.transfer.destinationId, {
        kind: 'cancel-window',
        transferId: id,
        profileId: pending.transfer.profileId,
      }).then(
        () => this.restoring.delete(pending.transfer.destinationId),
        this.dependencies.report,
      );
    } else this.dependencies.dismiss(pending.transfer.destinationId);
  }

  private fail(id: string, error: unknown): void {
    try {
      this.cancelPending(id, error);
    } catch (failure) {
      const pending = this.live.get(id);
      pending?.ready.reject(failure);
      pending?.committed.reject(failure);
      this.dependencies.report(failure);
    }
  }
}

export function registerWindowTransferIpc(
  ipc: Pick<IpcMain, 'handle'>,
  context: (event: IpcMainInvokeEvent) => DesktopWindowContext,
  transfers: WindowTransfers,
): void {
  ipc.handle('puddle:window-prepare-pane', (event, value: unknown) => {
    const owner = context(event);
    if (Buffer.byteLength(JSON.stringify(value)) > 16 * 1024 * 1024)
      throw new Error('Transfer is too large');
    return transfers.preparePane(owner.identity.id, desktopPaneDetachSchema.parse(value));
  });
  ipc.handle('puddle:window-prepare-dock', (event, value: unknown) => {
    const owner = context(event);
    if (Buffer.byteLength(JSON.stringify(value)) > 16 * 1024 * 1024)
      throw new Error('Transfer is too large');
    return transfers.prepareDock(owner.identity.id, desktopPaneDockSchema.parse(value));
  });
  ipc.handle('puddle:window-prepare-tab-dock', (event, value: unknown) => {
    const owner = context(event);
    if (Buffer.byteLength(JSON.stringify(value)) > 16 * 1024 * 1024)
      throw new Error('Transfer is too large');
    return transfers.prepareTabDock(owner.identity.id, desktopTabDockSchema.parse(value));
  });
  ipc.handle('puddle:window-transfer-retire', (event, value: unknown) => {
    const owner = context(event);
    return transfers.retire(owner.identity.id, desktopTransferRetireSchema.parse(value));
  });
  for (const operation of ['commit', 'cancel', 'observe', 'accept'] as const) {
    ipc.handle(`puddle:window-transfer-${operation}`, (event, value: unknown) => {
      const owner = context(event);
      return transfers[operation](owner.identity.id, desktopTransferReferenceSchema.parse(value));
    });
  }
}
