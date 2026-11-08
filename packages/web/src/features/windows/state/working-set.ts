import {
  uiStateSnapshotSchema,
  hasHuddleTabs,
  type DesktopWorkspaceContent,
  type DesktopWorkspaceVersion,
  type DesktopWindowsBridge,
  type DesktopWindowWriteResult,
  type UiStateSnapshot,
} from '@puddle/shared';
import { retainLateDrafts } from './late-draft-recovery';

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
  private durable = false;
  private frozen = false;
  private checkpointing = false;
  private loading: Promise<void> | null = null;
  private writing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly profileId: string,
    private readonly bridge: Pick<DesktopWindowsBridge, 'read' | 'write' | 'huddles'>,
    private readonly content: WindowContentSource,
    private readonly reportError: (error: unknown) => void,
    private readonly onSaved?: (result: DesktopWindowWriteResult) => void,
    private staged = false,
  ) {
    this.frozen = staged;
  }

  get = (): UiStateSnapshot => this.snapshot;
  loaded = (): boolean => this.ready;
  restored = (): boolean => this.durable;
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
        this.requireSupported(stored.content.snapshot);
        this.durable = true;
        this.revision = stored.revision;
        this.snapshot = stored.content.snapshot;
        this.content.restore(stored.content);
      } else {
        if (this.staged) throw new Error('The prepared window is no longer available');
        const snapshot = await seed();
        this.requireSupported(snapshot);
        this.snapshot = snapshot;
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
    // The first render may propose migration/pruning defaults. A staging
    // destination must show exactly its capture until ownership is committed.
    if (this.staged) return;
    if (this.frozen) throw new Error('Window transfer is pending');
    const next = { ...this.snapshot, ...patch };
    this.requireSupported(next);
    this.snapshot = next;
    this.changed();
    this.notify();
  }

  private requireSupported(snapshot: UiStateSnapshot): void {
    if (!this.bridge.huddles && hasHuddleTabs(snapshot))
      throw new Error(
        'Update the desktop app before opening this workspace: it contains huddle tabs',
      );
  }

  /** Buffers/view state can change without changing the layout tree. */
  changed(): void {
    if (!this.ready || this.staged) return;
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
    if (this.staged) return Promise.resolve();
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
  async freeze(reason: 'transfer' | 'checkpoint' = 'transfer'): Promise<DesktopWorkspaceVersion> {
    if (!this.ready || this.frozen) throw new Error('Window cannot start another transfer');
    this.frozen = true;
    this.checkpointing = reason === 'checkpoint';
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
    if (!this.frozen || this.staged) return;
    this.frozen = false;
    this.checkpointing = false;
    this.changed();
    this.notify();
  }

  /** A close may arrive while the first profile seed is still loading. */
  async checkpoint(): Promise<void> {
    await this.loading;
    if (!this.ready) return;
    if (this.frozen) throw new Error('A window transfer is still pending');
    await this.freeze('checkpoint');
  }

  resumeCheckpoint(): void {
    if (this.checkpointing) this.resume();
  }

  matchesCapture(version: DesktopWorkspaceVersion): boolean {
    if (!this.frozen || this.revision !== version.revision) return false;
    const current = {
      snapshot: this.snapshot,
      buffers: this.content.capture(this.snapshot).buffers,
    };
    return (
      JSON.stringify(current) ===
      JSON.stringify({ snapshot: version.content.snapshot, buffers: version.content.buffers })
    );
  }

  /** Read a fenced presentation for exceptional cancellation recovery; never publishes it. */
  sealedCapture(): DesktopWorkspaceVersion {
    if (!this.ready || !this.frozen || this.writing) throw new Error('Window is not sealed');
    return {
      revision: this.revision,
      content: { snapshot: this.snapshot, ...this.content.capture(this.snapshot) },
    };
  }

  /** Suppress cleanup writes while the destination's existing views unmount. */
  beginStaging(): void {
    if (!this.frozen || this.staged || this.writing)
      throw new Error('Window cannot stage a transfer');
    this.staged = true;
  }

  /** Install a prepared presentation only after old models have been released. */
  stage(version: DesktopWorkspaceVersion): void {
    if (!this.frozen || !this.staged || this.writing || version.revision !== this.revision)
      throw new Error('Window state changed before staging');
    this.snapshot = version.content.snapshot;
    this.content.restore(version.content);
    this.notify();
  }

  /** After a committed/aborted transfer, adopt the main process's exact outcome. */
  adopt(
    version: DesktopWorkspaceVersion,
    captured?: DesktopWorkspaceVersion,
    projectId?: string,
  ): number {
    if (!this.frozen || this.writing) throw new Error('Window is not ready to adopt a transfer');
    if (version.revision < this.revision) throw new Error('Window revision moved backwards');
    const key = (buffer: DesktopWorkspaceContent['buffers'][number]) =>
      JSON.stringify([buffer.session, buffer.path, buffer.root ?? null]);
    const before = new Map(captured?.content.buffers.map((buffer) => [key(buffer), buffer]));
    // Kernel output or a pending editor operation can finish after source
    // confirmation. Keep that newer dirty text as source recovery instead of
    // replacing it with the earlier capture when the IPC reply arrives.
    const late = captured
      ? this.content
          .capture(this.snapshot)
          .buffers.filter(
            (buffer) => JSON.stringify(before.get(key(buffer))) !== JSON.stringify(buffer),
          )
      : [];
    const buffers = new Map(version.content.buffers.map((buffer) => [key(buffer), buffer]));
    for (const buffer of late) buffers.set(key(buffer), buffer);
    this.snapshot = late.length
      ? retainLateDrafts(version.content.snapshot, late, projectId)
      : version.content.snapshot;
    this.revision = version.revision;
    this.durable = true;
    this.content.restore(
      late.length
        ? { ...version.content, snapshot: this.snapshot, buffers: [...buffers.values()] }
        : version.content,
    );
    this.savedGeneration = this.generation;
    this.frozen = false;
    this.staged = false;
    this.checkpointing = false;
    this.notify();
    if (late.length) {
      this.changed();
      this.reportError(
        new Error(
          'An edit finished during the move. Its latest text remains open in this window for review.',
        ),
      );
    }
    return late.length;
  }
}
