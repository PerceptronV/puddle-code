import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  desktopPaneDetachSchema,
  desktopProjectFocusSchema,
  desktopProjectRouteSchema,
  type DesktopPaneDetach,
  type DesktopProjectFocus,
  type DesktopProjectRoute,
  type DesktopProjectCommand,
  type DesktopWindowContext,
} from '@puddle/shared';
import { reopenWindowId, type ReopenWindow } from '../reopen.js';
import type { DesktopWindowState } from './persistence/state.js';
import type { WindowTransfers } from './transfers/coordinator.js';

/** Native ownership and routing; project contents still use the shared workspace handoff. */
export class ProjectWindows {
  constructor(
    private readonly environment: {
      state(): DesktopWindowState;
      transfers: Pick<WindowTransfers, 'busy' | 'prepareProject' | 'restoreProject'>;
      record(id: string): ReopenWindow;
      open(record: ReopenWindow): Promise<void>;
      raise(id: string): void;
      command(id: string, command: DesktopProjectCommand): Promise<void>;
    },
  ) {}

  async focus(sourceId: string, request: DesktopProjectFocus): Promise<boolean> {
    const source = this.environment.record(sourceId);
    const state = this.environment.state();
    const found = state.projectWindow(sourceId, request.profileId, request.projectId);
    if (found) {
      const id = reopenWindowId(found.record);
      if (this.environment.transfers.busy(id)) throw new Error('This project is being moved');
      const record = found.returned ? state.reopenProject(id) : found.record;
      try {
        await this.environment.open(record);
        this.environment.record(id);
      } catch (error) {
        // A failed native creation must not strand the previously returnable
        // workspace. A window that did open keeps its durable ownership.
        let live = false;
        try {
          this.environment.record(id);
          live = true;
        } catch {
          /* No registered renderer. */
        }
        if (found.returned && !live) {
          const version = state.read(id, request.profileId);
          if (version) state.closeProject(id, version.revision);
        }
        throw error;
      }
      this.environment.raise(id);
      return true;
    }
    if (source.window?.kind === 'host') return false;
    const host = await this.host(source.target);
    await this.environment.command(reopenWindowId(host), { ...request, kind: 'open-project' });
    return true;
  }

  prepare(sourceId: string, request: DesktopPaneDetach): Promise<void> {
    this.environment.record(sourceId);
    return this.environment.transfers.prepareProject(sourceId, request);
  }

  async route(sourceId: string, request: DesktopProjectRoute): Promise<boolean> {
    const source = this.environment.record(sourceId);
    const identity = source.window;
    const projectId = /^\/project\/([0-9a-f]{10})(?:\/|$)/.exec(request.route)?.[1];
    if (
      identity?.kind !== 'host' &&
      identity?.profileId === request.profileId &&
      identity.projectId === projectId
    )
      return false;
    const state = this.environment.state();
    const found = projectId ? state.projectWindow(sourceId, request.profileId, projectId) : null;
    if (found?.open || (found && state.staging(reopenWindowId(found.record)))) {
      const id = reopenWindowId(found.record);
      if (this.environment.transfers.busy(id)) throw new Error('This project is being moved');
      await this.environment.open(found.record);
      await this.environment.command(id, { ...request, kind: 'navigate-project' });
      this.environment.raise(id);
      return true;
    }
    if (identity?.kind !== 'host') {
      const host = await this.host(source.target);
      await this.environment.command(reopenWindowId(host), {
        ...request,
        kind: 'navigate-project',
      });
      this.environment.raise(reopenWindowId(host));
      return true;
    }
    if (!found?.returned) return false;
    await this.environment.transfers.restoreProject(
      reopenWindowId(found.record),
      sourceId,
      request.profileId,
      request.route,
    );
    return true;
  }

  private async host(target: string): Promise<ReopenWindow> {
    const host = this.environment
      .state()
      .openWindows()
      .find((record) => record.target === target && record.window?.kind === 'host') ?? {
      target,
      window: { kind: 'host' as const, id: reopenWindowId({ target }) },
      route: '/',
    };
    await this.environment.open(host);
    return host;
  }
}

export function registerProjectWindowIpc(
  ipc: Pick<IpcMain, 'handle'>,
  context: (event: IpcMainInvokeEvent) => DesktopWindowContext,
  projects: ProjectWindows,
): void {
  ipc.handle('puddle:window-prepare-project', (event, value: unknown) => {
    const owner = context(event);
    if (Buffer.byteLength(JSON.stringify(value)) > 16 * 1024 * 1024)
      throw new Error('Transfer is too large');
    return projects.prepare(owner.identity.id, desktopPaneDetachSchema.parse(value));
  });
  ipc.handle('puddle:window-focus-project', (event, value: unknown) => {
    const owner = context(event);
    return projects.focus(owner.identity.id, desktopProjectFocusSchema.parse(value));
  });
  ipc.handle('puddle:window-route-project', (event, value: unknown) => {
    const owner = context(event);
    return projects.route(owner.identity.id, desktopProjectRouteSchema.parse(value));
  });
}
