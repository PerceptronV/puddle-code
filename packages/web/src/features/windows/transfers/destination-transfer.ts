import {
  desktopWorkspaceVersionSchema,
  type DesktopWindowTransferCommand,
  type DesktopWorkspaceVersion,
} from '@puddle/shared';
import type { DesktopWorkingSet } from '../state/working-set';
import { dockPaneContent, dockTabContent } from './content/dock-content';
import { returnProjectContent } from './content/project-content';

interface Pending {
  id: string;
  profileId: string;
  projectId: string;
  owner: DesktopWorkingSet;
  original: DesktopWorkspaceVersion;
  planned: DesktopWorkspaceVersion;
  staged?: DesktopWorkspaceVersion;
  route: string;
  destinationRoute: string;
}

/** Destination half of a move into an existing window; independent of React/Monaco. */
export class DestinationTransfer {
  private pending: Pending | null = null;

  constructor(
    private readonly environment: {
      activeProfile(): string | null;
      owner(profileId: string): Promise<DesktopWorkingSet>;
      read(profileId: string): Promise<DesktopWorkspaceVersion | null>;
      fence(active: boolean): void;
      suspend(active: boolean): void;
      staging(id?: string): void;
      route(): string;
      navigate(route: string): void;
    },
  ) {}

  async command(
    command: DesktopWindowTransferCommand,
  ): Promise<DesktopWorkspaceVersion | undefined> {
    if (
      command.kind === 'plan-pane' ||
      command.kind === 'plan-tab' ||
      command.kind === 'plan-project'
    )
      return this.plan(command);
    const pending = this.pending;
    if (!pending) {
      if (command.kind === 'cancel-window') return;
      throw new Error('The destination plan is unavailable');
    }
    if (command.transferId !== pending.id || command.profileId !== pending.profileId)
      throw new Error('The destination belongs to another transfer');
    if (command.kind === 'cancel-window') {
      // Main has already made cancellation durable. Preserve any late editor
      // work before restoring the original presentation and route.
      if (pending.staged) this.environment.suspend(true);
      const late = pending.owner.adopt(
        pending.original,
        pending.staged ?? pending.original,
        pending.projectId,
      );
      this.environment.navigate(pending.route);
      this.environment.staging();
      this.pending = null;
      this.environment.suspend(false);
      this.environment.fence(false);
      if (late) await pending.owner.flush();
      return;
    }
    if (
      this.environment.activeProfile() !== pending.profileId ||
      !pending.owner.matchesCapture(pending.original)
    )
      throw new Error('The destination changed while preparing the move');
    pending.owner.beginStaging();
    this.environment.suspend(true);
    // Passive model disposals and draft cleanup complete before replacing state.
    await Promise.resolve();
    if (!pending.owner.matchesCapture(pending.original))
      throw new Error('The destination changed while releasing its views');
    const staged = await this.environment.read(pending.profileId);
    if (!staged || JSON.stringify(staged) !== JSON.stringify(pending.planned))
      throw new Error('The prepared destination has changed');
    pending.owner.stage(staged);
    pending.staged = staged;
    this.environment.staging(pending.id);
    this.environment.navigate(pending.destinationRoute);
    this.environment.suspend(false);
  }

  private async plan(
    command: Extract<
      DesktopWindowTransferCommand,
      { kind: 'plan-pane' | 'plan-tab' | 'plan-project' }
    >,
  ) {
    if (this.pending) throw new Error('This window is already receiving a transfer');
    if (this.environment.activeProfile() !== command.profileId)
      throw new Error('Select the same profile in the destination window before docking');
    const owner = await this.environment.owner(command.profileId);
    if (this.environment.activeProfile() !== command.profileId)
      throw new Error('The destination profile changed');
    this.environment.fence(true);
    let original: DesktopWorkspaceVersion | undefined;
    try {
      original = await owner.freeze();
      const planned = desktopWorkspaceVersionSchema.parse({
        revision: original.revision,
        content:
          command.kind === 'plan-project'
            ? returnProjectContent(original.content, command.content, command.projectId)
            : command.kind === 'plan-pane'
              ? dockPaneContent(
                  original.content,
                  command.content,
                  command.projectId,
                  command.placement,
                )
              : dockTabContent(
                  original.content,
                  command.content,
                  command.projectId,
                  command.placement,
                ),
      });
      this.pending = {
        id: command.transferId,
        profileId: command.profileId,
        projectId: command.projectId,
        owner,
        original,
        planned,
        route: this.environment.route(),
        destinationRoute:
          command.kind === 'plan-project'
            ? (command.route ?? `/project/${command.projectId}`)
            : `/project/${command.projectId}`,
      };
      return planned;
    } catch (error) {
      if (original) owner.resume();
      if (!owner.locked()) this.environment.fence(false);
      throw error;
    }
  }

  /** Called by the shared Workspace's acceptance hook after durable commit. */
  async committed(id: string, version: DesktopWorkspaceVersion): Promise<boolean> {
    const pending = this.pending;
    if (!pending || pending.id !== id) return false;
    if (!pending.staged) throw new Error('Destination has not mounted its prepared state');
    const late = pending.owner.adopt(version, pending.staged, pending.projectId);
    this.pending = null;
    this.environment.staging();
    this.environment.fence(false);
    if (late) await pending.owner.flush();
    return true;
  }
}
