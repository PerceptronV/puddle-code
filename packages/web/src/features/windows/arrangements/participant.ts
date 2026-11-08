import type { DesktopArrangementCommand, DesktopWorkspaceVersion } from '@puddle/shared';
import type { DesktopWorkingSet } from '../state/working-set';

interface Pending {
  id: string;
  profileId: string;
  owner: DesktopWorkingSet;
  original?: DesktopWorkspaceVersion;
  originalRoute: string;
  planned?: DesktopWorkspaceVersion;
  destinationRoute?: string;
  mounted: boolean;
  verified: boolean;
  ready?: () => void;
}

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const projectFromRoute = (route: string) => /^\/project\/([0-9a-f]{10})/.exec(route)?.[1];

/** One renderer's reversible presentation. Main alone commits the complete window set. */
export class ArrangementParticipant {
  private pending: Pending | null = null;
  private finished: { id: string; profileId: string; outcome: 'committed' | 'cancelled' } | null =
    null;

  constructor(
    private readonly environment: {
      activeProfile(): string | null;
      owner(profileId: string): Promise<DesktopWorkingSet>;
      read(profileId: string): Promise<DesktopWorkspaceVersion | null>;
      initialArrangement(): string | undefined;
      fence(active: boolean): void;
      suspend(active: boolean): void;
      staging(id?: string): void;
      route(): string;
      navigate(route: string): void;
    },
    private readonly mountTimeoutMs = 8_000,
  ) {}

  async command(command: DesktopArrangementCommand): Promise<DesktopWorkspaceVersion | undefined> {
    if (this.finished?.id === command.arrangementId) {
      if (
        command.kind === 'finish-layout' &&
        command.profileId === this.finished.profileId &&
        command.outcome === this.finished.outcome
      )
        return;
      throw new Error('This layout arrangement has already finished');
    }
    if (
      this.pending &&
      (this.pending.id !== command.arrangementId || this.pending.profileId !== command.profileId)
    )
      throw new Error('This window belongs to another layout arrangement');
    if (command.kind === 'seal-layout') return this.seal(command);
    if (command.kind === 'stage-layout') return this.stage(command);
    const pending = this.pending;
    if (!pending) throw new Error('The window layout plan is unavailable');
    if (command.kind === 'finish-layout') {
      await this.finish(pending, command.outcome);
      return;
    }
    if (pending.planned && !pending.mounted)
      throw new Error('The window has not mounted its prepared layout');
    const captured = pending.planned ?? pending.original;
    if (!captured) throw new Error('The window layout capture is unavailable');
    this.checkProfile(pending.profileId);
    if (this.environment.route() !== (pending.destinationRoute ?? pending.originalRoute))
      throw new Error('The window route changed while applying its layout');
    // Release mounted models again before the coordinator's final validation.
    // Nothing can keep editing a participant between its vote and atomic commit.
    this.environment.suspend(true);
    await Promise.resolve();
    if (!pending.owner.matchesCapture(captured))
      throw new Error('The prepared layout changed while releasing its views');
    pending.verified = true;
    return captured;
  }

  private checkProfile(profileId: string): void {
    if (this.environment.activeProfile() !== profileId)
      throw new Error('The window profile changed while applying its layout');
  }

  private async seal(command: Extract<DesktopArrangementCommand, { kind: 'seal-layout' }>) {
    this.checkProfile(command.profileId);
    if (this.pending) {
      if (
        !this.pending.original ||
        this.pending.planned ||
        !this.pending.owner.matchesCapture(this.pending.original)
      )
        throw new Error('The window has changed since layout capture');
      return this.pending.original;
    }
    if (this.environment.initialArrangement())
      throw new Error('A prepared window cannot start another layout');
    const owner = await this.environment.owner(command.profileId);
    this.checkProfile(command.profileId);
    this.environment.fence(true);
    try {
      const original = await owner.freeze();
      this.pending = {
        id: command.arrangementId,
        profileId: command.profileId,
        owner,
        original,
        originalRoute: this.environment.route(),
        mounted: false,
        verified: false,
      };
      owner.beginStaging();
      this.environment.suspend(true);
      await Promise.resolve();
      if (!owner.matchesCapture(original))
        throw new Error('The window changed while releasing its views');
      return original;
    } catch (error) {
      // Once sealed, main must cancel the whole operation, including participants
      // whose reply failed. Keep cleanup edits fenced and available for rollback.
      if (!owner.locked()) this.environment.fence(false);
      throw error;
    }
  }

  private async stage(command: Extract<DesktopArrangementCommand, { kind: 'stage-layout' }>) {
    this.checkProfile(command.profileId);
    let pending = this.pending;
    if (!pending) {
      if (this.environment.initialArrangement() !== command.arrangementId)
        throw new Error('The window was not prepared for this layout');
      const owner = await this.environment.owner(command.profileId);
      this.checkProfile(command.profileId);
      pending = this.pending = {
        id: command.arrangementId,
        profileId: command.profileId,
        owner,
        originalRoute: this.environment.route(),
        mounted: false,
        verified: false,
      };
    }
    if (pending.planned) {
      if (!equal(pending.planned, command.version) || pending.destinationRoute !== command.route)
        throw new Error('The prepared window layout changed');
      if (!pending.mounted) throw new Error('The prepared window did not finish mounting');
      return pending.planned;
    }
    this.environment.fence(true);
    this.environment.suspend(true);
    await Promise.resolve();
    if (!pending.owner.matchesCapture(pending.original ?? command.version))
      throw new Error('The window changed before staging its layout');
    const stored = await this.environment.read(command.profileId);
    this.checkProfile(command.profileId);
    if (!stored || !equal(stored, command.version))
      throw new Error('The durable prepared window layout changed');
    pending.owner.stage(stored);
    pending.planned = stored;
    pending.verified = false;
    pending.destinationRoute = command.route;
    this.environment.staging(pending.id);
    this.environment.navigate(command.route);
    // Install the waiter before remounting: the ordinary Workspace/dashboard
    // reports readiness, including the same lazy chunks used outside transfers.
    const mounted = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.ready = undefined;
        reject(new Error('The prepared window did not finish mounting'));
      }, this.mountTimeoutMs);
      pending.ready = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    try {
      this.environment.suspend(false);
      await mounted;
      this.checkProfile(command.profileId);
      return stored;
    } catch (error) {
      // Keep ownership unchanged and interaction fenced until main cancels.
      pending.ready?.();
      pending.ready = undefined;
      this.environment.suspend(true);
      throw error;
    }
  }

  /** Called after the reused presentation has actually mounted, never on bridge readiness alone. */
  mounted(profileId: string): void {
    const pending = this.pending;
    if (
      !pending?.planned ||
      pending.profileId !== profileId ||
      this.environment.activeProfile() !== profileId ||
      pending.destinationRoute !== this.environment.route() ||
      !pending.ready
    )
      return;
    pending.mounted = true;
    pending.ready();
    pending.ready = undefined;
  }

  private async finish(pending: Pending, outcome: 'committed' | 'cancelled') {
    if (outcome === 'committed') this.checkProfile(pending.profileId);
    if (outcome === 'committed' && (!pending.verified || !pending.planned))
      throw new Error('The layout must be verified before accepting its commit');
    this.environment.suspend(true);
    await Promise.resolve();
    if (outcome === 'cancelled' && !pending.original) {
      // A new/replaced renderer has no in-memory original. After cancellation
      // main closes a new destination or reloads an existing participant from its
      // retained original; never expose an editable copy of imported drafts.
      this.finished = { id: pending.id, profileId: pending.profileId, outcome };
      this.pending = null;
      return;
    }
    const expected =
      outcome === 'committed'
        ? { ...pending.planned!, revision: pending.planned!.revision + 1 }
        : pending.original!;
    const durable = await this.environment.read(pending.profileId);
    if (!durable || !equal(durable, expected))
      throw new Error('The durable layout outcome has not been confirmed');
    const route = outcome === 'committed' ? pending.destinationRoute! : pending.originalRoute;
    const late = pending.owner.adopt(
      durable,
      pending.planned ?? pending.original,
      projectFromRoute(route),
    );
    this.environment.navigate(route);
    this.environment.staging();
    this.finished = { id: pending.id, profileId: pending.profileId, outcome };
    this.pending = null;
    this.environment.suspend(false);
    this.environment.fence(false);
    if (late) await pending.owner.flush();
  }
}
