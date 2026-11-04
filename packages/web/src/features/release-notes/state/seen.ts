export interface ReleaseSeenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Presentation preferences only. Storage denial falls back to this document's memory. */
export class ReleaseNotesSeen {
  private readonly memory = new Set<string>();
  constructor(private readonly storage: () => ReleaseSeenStorage = () => localStorage) {}

  has(identity: string): boolean {
    if (this.memory.has(identity)) return true;
    try {
      return this.storage().getItem(this.key(identity)) === 'seen';
    } catch {
      return false;
    }
  }

  mark(identity: string): void {
    this.memory.add(identity);
    try {
      this.storage().setItem(this.key(identity), 'seen');
    } catch {
      // Private browsing/full storage must not block notes or reopen them on every render.
    }
  }

  private key(identity: string): string {
    return `puddle.release-notes.v1:${identity}`;
  }
}
