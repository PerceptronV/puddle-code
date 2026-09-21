/** Bounded in-memory admission budget; identities and request contents are never logged. */
export class RateLimit {
  private readonly entries = new Map<string, { count: number; until: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now = Date.now,
  ) {}
  take(key: string): boolean {
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry || entry.until <= now) {
      if (this.entries.size >= 10_000) {
        for (const [key, record] of this.entries) if (record.until <= now) this.entries.delete(key);
        if (this.entries.size >= 10_000) return false;
      }
      entry = { count: 0, until: now + this.windowMs };
      this.entries.set(key, entry);
    }
    return ++entry.count <= this.limit;
  }
}
