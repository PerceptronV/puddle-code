import { currentProfileId } from '../../profile/profile-store';
import { desktopWindowContext } from '../../windows/window-context';
import { desktopContentState } from '../../windows/state/content-state';

/** Bounded window view state; named stores join desktop recovery and handoff. */
export class ViewStateStore<T> {
  private readonly entries = new Map<string, T>();

  constructor(
    private readonly limit = 500,
    private readonly namespace?: string,
  ) {}

  private desktopState() {
    if (!this.namespace || !desktopWindowContext()) return null;
    const profile = currentProfileId();
    return profile ? desktopContentState(profile) : null;
  }

  get(key: string): T | undefined {
    // A returned pane can reuse a key this renderer cached before detachment.
    // Desktop adoption is authoritative; never shadow its newer position with
    // that old per-store cache entry (or resurrect a key the snapshot removed).
    const desktop = this.desktopState();
    const value = desktop ? desktop.view<T>(`${this.namespace}:${key}`) : this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: T): void {
    this.desktopState()?.setView(`${this.namespace}:${key}`, value);
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
