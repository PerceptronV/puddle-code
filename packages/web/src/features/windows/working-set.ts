import {
  uiStateSnapshotSchema,
  type DesktopWorkspaceContent,
  type DesktopWorkspaceVersion,
  type DesktopWindowsBridge,
  type DesktopWindowWriteResult,
  type UiStateSnapshot,
} from '@puddle/shared';

export interface WindowContentSource {
  capture(snapshot: UiStateSnapshot): Pick<DesktopWorkspaceContent, 'buffers' | 'views'>;
  restore(content: DesktopWorkspaceContent): void;
}

/**
 * One renderer's optimistic working set. Writes are serial and revisioned; a
 * lost acknowledgement is observed before another write can be dispatched.
 * React composition and Monaco remain outside this controller.
 */
export class DesktopWorkingSet {
  private snapshot: UiStateSnapshot = uiStateSnapshotSchema.parse({});
  private revision = 0;
  private generation = 0;
  private savedGeneration = 0;
  private ready = false;
  private frozen = false;
  private loading: Promise<void> | null = null;
  private writing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly profileId: string,
    private readonly bridge: Pick<DesktopWindowsBridge, 'read' | 'write'>,
    private readonly content: WindowContentSource,
    private readonly reportError: (error: unknown) => void,
    private readonly onSaved?: (result: DesktopWindowWriteResult) => void,
  ) {}

  get = (): UiStateSnapshot => this.snapshot;
  loaded = (): boolean => this.ready;
  locked = (): boolean => this.frozen;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  load(seed: () => Promise<UiStateSnapshot>): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const stored = await this.bridge.read(this.profileId);
      if (stored) {
        this.revision = stored.revision;
        this.snapshot = stored.content.snapshot;
        this.content.restore(stored.content);
      } else {
        this.snapshot = await seed();
        this.content.restore({ snapshot: this.snapshot, buffers: [], views: {} });
      }
      this.ready = true;
      this.notify();
      if (!stored) {
        this.generation++;
        await this.flush();
      }
    })().catch((error: unknown) => {
      this.loading = null;
      throw error;
    });
    return this.loading;
  }

  update(patch: Partial<UiStateSnapshot>): void {
    if (!this.ready) throw new Error('Window working set has not loaded');
    if (this.frozen) throw new Error('Window transfer is pending');
    this.snapshot = { ...this.snapshot, ...patch };
    this.changed();
    this.notify();
  }

  /** Buffers/view state can change without changing the layout tree. */
  changed(): void {
    if (!this.ready) return;
    this.generation++;
    if (this.frozen) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(this.reportError);
    }, 250);
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.writing) return this.writing;
    const operation = this.drain().finally(() => {
      if (this.writing === operation) this.writing = null;
    });
    this.writing = operation;
    return operation;
  }

  private async drain(): Promise<void> {
    while (this.savedGeneration < this.generation) {
      const generation = this.generation;
      const content: DesktopWorkspaceContent = {
        snapshot: this.snapshot,
        ...this.content.capture(this.snapshot),
      };
      let saved: DesktopWindowWriteResult;
      try {
        saved = await this.bridge.write({
          profileId: this.profileId,
          revision: this.revision,
          content,
        });
      } catch (error) {
        // Never blindly retry an uncertain write. A matching durable revision
        // proves acceptance; a different one must be reconciled explicitly.
        const observed = await this.bridge.read(this.profileId).catch(() => null);
        if (
          !observed ||
          observed.revision <= this.revision ||
          JSON.stringify(observed.content) !== JSON.stringify(content)
        )
          throw error;
        saved = observed;
      }
      this.revision = saved.revision;
      this.savedGeneration = generation;
      this.onSaved?.(saved);
    }
  }

  /** The caller fences editor interaction before capture, then asks main to prepare. */
  async freeze(): Promise<DesktopWorkspaceVersion> {
    if (!this.ready || this.frozen) throw new Error('Window cannot start another transfer');
    this.frozen = true;
    this.generation++;
    this.notify();
    try {
      await this.flush();
      return {
        revision: this.revision,
        content: { snapshot: this.snapshot, ...this.content.capture(this.snapshot) },
      };
    } catch (error) {
      this.frozen = false;
      this.notify();
      throw error;
    }
  }

  /** Cancel a close/transfer without replacing live models with an older capture. */
  resume(): void {
    if (!this.frozen) return;
    this.frozen = false;
    this.changed();
    this.notify();
  }

  /** A close may arrive while the first profile seed is still loading. */
  async checkpoint(): Promise<void> {
    await this.loading;
    if (!this.ready) return;
    if (this.frozen) throw new Error('A window transfer is still pending');
    await this.freeze();
  }

  /** After a committed/aborted transfer, adopt the main process's exact outcome. */
  adopt(version: DesktopWorkspaceVersion): void {
    if (!this.frozen || this.writing) throw new Error('Window is not ready to adopt a transfer');
    if (version.revision < this.revision) throw new Error('Window revision moved backwards');
    this.snapshot = version.content.snapshot;
    this.revision = version.revision;
    this.content.restore(version.content);
    this.savedGeneration = this.generation;
    this.frozen = false;
    this.notify();
  }
}
