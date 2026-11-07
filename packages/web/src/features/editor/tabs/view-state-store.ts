import { currentProfileId } from '../../profile/profile-store';
import { desktopWindowContext } from '../../windows/window-context';
import { desktopContentState } from '../../windows/content-state';

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
    const value = this.entries.get(key) ?? this.desktopState()?.view<T>(`${this.namespace}:${key}`);
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
