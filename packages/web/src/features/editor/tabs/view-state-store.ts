import { currentProfileId } from '../../profile/profile-store';
import { desktopWindowContext } from '../../windows/window-context';
import { desktopContentState } from '../../windows/state/content-state';

/** Bounded window view state; named stores join desktop recovery and handoff. */
export class ViewStateStore<T> {
  private readonly entries = new Map<string, T>();
  private browserLoaded = false;
  private browserWrite: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly limit = 500,
    private readonly namespace?: string,
    private readonly persistBrowser = false,
  ) {}

  private loadBrowser(): void {
    if (!this.persistBrowser || !this.namespace || this.browserLoaded) return;
    this.browserLoaded = true;
    try {
      const raw = sessionStorage.getItem(`puddle.views.${this.namespace}`);
      if (raw && raw.length <= 1024 * 1024 && new TextEncoder().encode(raw).length <= 1024 * 1024) {
        const entries: unknown = JSON.parse(raw);
        if (Array.isArray(entries) && entries.length <= this.limit) {
          for (const entry of entries) {
            if (
              Array.isArray(entry) &&
              entry.length === 2 &&
              typeof entry[0] === 'string' &&
              entry[0].length <= 1024
            )
              this.entries.set(entry[0], entry[1] as T);
          }
        }
      }
    } catch {
      /* Disabled/corrupt browser storage must not prevent opening content. */
    }
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.flushBrowser);
  }

  private flushBrowser = (): void => {
    if (this.browserWrite !== null) clearTimeout(this.browserWrite);
    this.browserWrite = null;
    if (!this.persistBrowser || !this.namespace) return;
    try {
      const text = JSON.stringify([...this.entries]);
      if (text.length <= 1024 * 1024 && new TextEncoder().encode(text).length <= 1024 * 1024)
        sessionStorage.setItem(`puddle.views.${this.namespace}`, text);
    } catch {
      /* Quota/storage errors retain the in-memory view. */
    }
  };

  private desktopState() {
    if (!this.namespace || !desktopWindowContext()) return null;
    const profile = currentProfileId();
    return profile ? desktopContentState(profile) : null;
  }

  private trim(): void {
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get(key: string): T | undefined {
    // A returned pane can reuse a key this renderer cached before detachment.
    // Desktop adoption is authoritative; never shadow its newer position with
    // that old per-store cache entry (or resurrect a key the snapshot removed).
    const desktop = this.desktopState();
    if (!desktop) this.loadBrowser();
    const value = desktop ? desktop.view<T>(`${this.namespace}:${key}`) : this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
      this.trim();
    }
    return value;
  }

  set(key: string, value: T): void {
    const desktop = this.desktopState();
    if (!desktop) this.loadBrowser();
    desktop?.setView(`${this.namespace}:${key}`, value);
    this.entries.delete(key);
    this.entries.set(key, value);
    this.trim();
    if (!desktop && this.persistBrowser && this.browserWrite === null)
      this.browserWrite = setTimeout(this.flushBrowser, 250);
  }

  /** Copy selected view identities before a same-window tab move/copy changes pane keys. */
  copyKeys(remap: (key: string) => string | undefined): void {
    const desktop = this.desktopState();
    if (!desktop) this.loadBrowser();
    const prefix = `${this.namespace}:`;
    const entries = desktop
      ? Object.entries(desktop.viewSnapshot())
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => [key.slice(prefix.length), value as T] as const)
      : [...this.entries];
    for (const [key, value] of entries) {
      const destination = remap(key);
      if (destination && destination !== key) this.set(destination, value);
    }
  }
}
