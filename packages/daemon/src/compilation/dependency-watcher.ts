import { DependencyObserver } from './dependency-observer.js';

const WATCH_DEBOUNCE_MS = 350;

/** One target's debounced subscription; the service owns shared filesystem observation. */
export class DependencyWatcher {
  private subscription?: ReturnType<DependencyObserver['subscribe']>;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  constructor(
    private readonly observer: DependencyObserver,
    private readonly onChange: () => void,
  ) {}

  async replace(dependencies: readonly string[]): Promise<boolean> {
    const generation = ++this.generation;
    const previous = this.subscription;
    // Subscribe before releasing retained paths so baselines/watchers survive builds.
    this.subscription = this.observer.subscribe(dependencies, () => this.schedule(generation));
    previous?.close();
    // A change arriving just before build completion must survive replacement.
    if (this.debounceTimer) this.schedule(generation);
    await this.subscription.ready;
    return generation === this.generation;
  }

  close(): void {
    this.generation++;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.subscription?.close();
    this.subscription = undefined;
  }

  private schedule(generation: number): void {
    if (generation !== this.generation) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (generation === this.generation) this.onChange();
    }, WATCH_DEBOUNCE_MS);
    this.debounceTimer.unref();
  }
}
