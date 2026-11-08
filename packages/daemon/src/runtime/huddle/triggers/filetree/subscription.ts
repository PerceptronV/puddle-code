import { watch, type FSWatcher } from 'node:fs';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { HuddleDefinition, HuddleRevisionActivation } from '@puddle/shared';
import type { HuddleLedger } from '../../state/ledger.js';
import { requireFiletreeRoot, type FiletreeDefinition } from './definitions.js';
import { excludedFiletreePath, scanFiletree } from './snapshot.js';

/** One bounded observation stream; native events invalidate snapshots, never become edit claims. */
export class FiletreeSubscription {
  private abort = new AbortController();
  private watchers = new Map<string, { identity: string; watcher: FSWatcher }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | null = null;
  private dirty = false;
  private released = false;
  constructor(
    private readonly ledger: HuddleLedger,
    private readonly definition: FiletreeDefinition,
    private readonly activation: HuddleRevisionActivation,
    private readonly generation: number,
    private readonly limits: HuddleDefinition['execution'],
    private readonly admitted: () => void,
    private readonly failed: (error: unknown) => void,
    private readonly guard: () => void,
    private readonly release: () => void,
  ) {}
  async start() {
    await this.reconcile();
    if (!this.abort.signal.aborted)
      this.interval = setInterval(() => this.schedule(0), this.definition.reconcileMs);
  }
  stop() {
    this.abort.abort();
    clearTimeout(this.timer);
    clearInterval(this.interval);
    clearTimeout(this.watchdog);
    this.timer = undefined;
    this.interval = undefined;
    this.watchdog = undefined;
    for (const { watcher } of this.watchers.values()) watcher.close();
    this.watchers.clear();
    if (!this.running) this.releaseOnce();
  }
  settled() {
    return this.running ?? Promise.resolve();
  }
  private releaseOnce() {
    if (!this.released) {
      this.released = true;
      this.release();
    }
  }
  private failure(error: unknown) {
    if (this.abort.signal.aborted) return;
    this.stop();
    this.failed(
      new Error(
        `Filetree ${this.definition.node}: observation gap: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  private schedule(delay: number) {
    if (this.abort.signal.aborted) return;
    if (this.running) {
      this.dirty = true;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.reconcile().catch((error) => this.failure(error));
    }, delay);
  }
  private attach(path: string, relative: string, identity: string) {
    this.abort.signal.throwIfAborted();
    const previous = this.watchers.get(path);
    if (previous?.identity === identity) return;
    previous?.watcher.close();
    const watcher = watch(path, (_event, name) => {
      if (this.watchers.get(path)?.watcher !== watcher) return;
      const child = name === null ? null : relative ? `${relative}/${name}` : String(name);
      if (child !== null && excludedFiletreePath(this.definition, child)) return;
      this.schedule(this.definition.debounceMs);
    });
    this.watchers.set(path, { identity, watcher });
    watcher.on('error', (error) => {
      if (this.watchers.get(path)?.watcher === watcher) this.failure(error);
    });
  }
  private reconcile() {
    if (this.running) {
      this.dirty = true;
      return this.running;
    }
    const task = this.read();
    this.running = task;
    this.watchdog = setTimeout(
      () => this.failure(new Error('Filetree scan exceeded 10 seconds')),
      10000,
    );
    const finished = () => {
      clearTimeout(this.watchdog);
      this.watchdog = undefined;
      this.running = null;
      if (this.abort.signal.aborted) this.releaseOnce();
      else if (this.dirty) {
        this.dirty = false;
        this.schedule(this.definition.debounceMs);
      }
    };
    void task.then(finished, finished);
    return task;
  }
  private async flush() {
    // At most 32 batches for two 1024-file snapshots; yield between durable admissions.
    for (let batch = 0; batch < 32; batch++) {
      this.abort.signal.throwIfAborted();
      this.guard();
      requireFiletreeRoot(this.definition);
      if (
        !this.ledger.filetrees.admit(this.definition.slot, this.generation, this.limits, Date.now())
      )
        return;
      this.admitted();
      await yieldTurn();
    }
    if (this.ledger.filetrees.current(this.definition.slot)?.pending)
      throw new Error('Filetree reconciliation exceeds its admission bound');
  }
  private async read() {
    this.abort.signal.throwIfAborted();
    this.guard();
    const result = await scanFiletree(
      this.definition,
      this.abort.signal,
      (path, relative, identity) => this.attach(path, relative, identity),
    );
    this.abort.signal.throwIfAborted();
    this.guard();
    for (const [path, { watcher }] of this.watchers) {
      if (!result.directories.has(path)) {
        watcher.close();
        this.watchers.delete(path);
      }
    }
    this.ledger.filetrees.initialise(this.definition, this.activation, result.snapshot);
    await this.flush();
    this.abort.signal.throwIfAborted();
    this.ledger.filetrees.capture(
      this.definition.slot,
      this.generation,
      result.snapshot,
      Date.now(),
    );
    await this.flush();
  }
}
