import { randomUUID } from 'node:crypto';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  desktopPaneDetachSchema,
  desktopTransferReferenceSchema,
  type DesktopPaneDetach,
  type DesktopTransferObservation,
  type DesktopTransferReference,
  type DesktopWindowContext,
  type DesktopWindowTransfer,
  type DesktopWorkspaceVersion,
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
}

/** A destination stages first; source confirmation then makes the ownership change durable. */
export class WindowTransfers {
  private readonly live = new Map<string, LiveTransfer>();

  constructor(
    private readonly dependencies: {
      state(): DesktopWindowState;
      record(id: string): ReopenWindow;
      open(record: ReopenWindow): Promise<void>;
      dismiss(id: string): void;
      report(error: unknown): void;
      committed?(): void;
      timeoutMs?: number;
    },
  ) {}

  preparePane(sourceId: string, request: DesktopPaneDetach): Promise<void> {
    const source = this.dependencies.record(sourceId);
    if (source.window?.kind === 'pane') throw new Error('This pane is already in its own window');
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
      sourceRoute: `/project/${request.projectId}`,
    });
    const pending: LiveTransfer = {
      transfer,
      accepted: false,
      ready: deferred<void>(),
      committed: deferred<DesktopWorkspaceVersion>(),
      timer: setTimeout(
        () => this.fail(request.id, new Error('The new window did not accept its pane in time')),
        this.dependencies.timeoutMs ?? 30_000,
      ),
    };
    this.live.set(request.id, pending);
    void this.dependencies
      .open(destination)
      .catch((error: unknown) => this.fail(request.id, error));
    return pending.ready.promise;
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
    } catch (error) {
      this.dependencies.report(error);
    }
    return this.version(windowId, request.profileId);
  }

  observe(windowId: string, request: DesktopTransferReference): DesktopTransferObservation {
    const state = this.dependencies.state();
    const status = state.outcome(request.id) ?? 'unknown';
    if (status !== 'unknown') this.assertParty(windowId, request, 'source');
    return { status, version: state.read(windowId, request.profileId) };
  }

  cancel(windowId: string, request: DesktopTransferReference): DesktopTransferObservation {
    this.assertParty(windowId, request, 'source');
    if (this.dependencies.state().outcome(request.id) === 'prepared')
      this.cancelPending(request.id, new Error('Window transfer was cancelled'));
    return this.observe(windowId, request);
  }

  disconnected(windowId: string): void {
    for (const [id, { transfer }] of this.live) {
      if (transfer.sourceId === windowId || transfer.destinationId === windowId)
        this.fail(id, new Error('Window disconnected during the transfer'));
    }
  }

  private assertParty(
    windowId: string,
    request: DesktopTransferReference,
    party: 'source' | 'destination',
  ): void {
    const state = this.dependencies.state();
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
    this.dependencies.dismiss(pending.transfer.destinationId);
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
  for (const operation of ['commit', 'cancel', 'observe', 'accept'] as const) {
    ipc.handle(`puddle:window-transfer-${operation}`, (event, value: unknown) => {
      const owner = context(event);
      return transfers[operation](owner.identity.id, desktopTransferReferenceSchema.parse(value));
    });
  }
}
