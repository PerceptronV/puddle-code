import type { HostInfo, ReleaseNotes } from '@puddle/shared';
import { releaseSection, type ReleaseComponent } from '../markdown/sections';
import { ReleaseNotesSeen } from './seen';

export interface InstalledReleaseNote {
  component: ReleaseComponent;
  version: string;
  markdown: string;
}
interface QueuedReleaseNote extends InstalledReleaseNote {
  identity: string;
}
export interface ReleaseNotesGroup {
  version: string;
  entries: readonly QueuedReleaseNote[];
}

/** Stable presentation scope, independent of cockpit ports and editable host labels. */
export function localReleaseHostKey(host: HostInfo): string {
  return JSON.stringify(['host', host.username, host.hostname, host.home]);
}

export class ReleaseNotesQueue {
  private groups: readonly ReleaseNotesGroup[] = [];
  private readonly listeners = new Set<() => void>();
  constructor(private readonly seen = new ReleaseNotesSeen()) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.groups;

  enqueue(hostKey: string, releases: readonly InstalledReleaseNote[]): void {
    let changed = false;
    for (const release of releases) {
      const scope = ['cockpit', 'remote'].includes(release.component) ? 'browser' : hostKey;
      const identity = JSON.stringify([scope, release.component, release.version]);
      if (
        this.seen.has(identity) ||
        this.groups.some((group) => group.entries.some((entry) => entry.identity === identity))
      )
        continue;
      const markdown = releaseSection(release.markdown, release.component);
      if (!markdown) continue;
      const entry = { ...release, markdown, identity };
      const group = this.groups.find(
        (value) =>
          value.version === release.version &&
          value.entries.every(
            (existing) =>
              existing.component !== release.component || existing.markdown === markdown,
          ),
      );
      this.groups = group
        ? this.groups.map((value) =>
            value === group ? { ...group, entries: [...group.entries, entry] } : value,
          )
        : [...this.groups, { version: release.version, entries: [entry] }];
      changed = true;
    }
    if (changed) this.emit();
  }

  /** Called after the corresponding preview has rendered, never when a source merely reports. */
  presented(group: ReleaseNotesGroup): void {
    for (const entry of group.entries) this.seen.mark(entry.identity);
  }

  dismiss(group: ReleaseNotesGroup): void {
    // Dismiss only the rendered group; later arriving sections must still be presented.
    this.presented(group);
    const identities = new Set(group.entries.map((entry) => entry.identity));
    this.groups = this.groups
      .map((value) => ({
        ...value,
        entries: value.entries.filter((e) => !identities.has(e.identity)),
      }))
      .filter((value) => value.entries.length > 0);
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}

export const releaseNotesQueue = new ReleaseNotesQueue();

/** The API contains installed metadata only; update offers/operation targets never enter here. */
export function reportInstalledReleaseNotes(hostKey: string, notes: ReleaseNotes): void {
  releaseNotesQueue.enqueue(hostKey, notes.releases);
}
