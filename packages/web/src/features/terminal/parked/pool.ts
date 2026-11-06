interface Entry {
  park(): Promise<boolean>;
  parkedAt: number | null;
  attempted: boolean;
}

/** Keep recent tab switches warm; serialise at most one old viewer at a time. */
export class ParkedTerminalPool {
  private readonly entries = new Set<Entry>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private working = false;
  private nextCaptureAt = 0;

  constructor(
    private readonly warmCount = 3,
    private readonly idleMs = 60_000,
  ) {}

  register(park: Entry['park']) {
    const entry: Entry = { park, parkedAt: null, attempted: false };
    this.entries.add(entry);
    return {
      setParked: (parked: boolean) => {
        if (parked === (entry.parkedAt !== null)) return;
        entry.parkedAt = parked ? Date.now() : null;
        entry.attempted = false;
        this.schedule();
      },
      dispose: () => {
        this.entries.delete(entry);
        this.schedule();
      },
    };
  }

  private candidates(): Entry[] {
    const parked = [...this.entries]
      .filter((entry) => entry.parkedAt !== null)
      .sort((a, b) => a.parkedAt! - b.parkedAt!);
    return parked
      .slice(0, Math.max(0, parked.length - this.warmCount))
      .filter((entry) => !entry.attempted);
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.working) return;
    const next = this.candidates()[0];
    if (!next) return;
    this.timer = setTimeout(
      () => void this.run(),
      Math.max(0, next.parkedAt! + this.idleMs - Date.now(), this.nextCaptureAt - Date.now()),
    );
  }

  private async run(): Promise<void> {
    this.timer = undefined;
    const next = this.candidates()[0];
    if (!next) return;
    this.working = true;
    next.attempted = true;
    try {
      if (await next.park()) this.entries.delete(next);
    } catch {
      // Keep the live viewer on capture failure. A later activation may retry.
    } finally {
      this.working = false;
      // Spread a large restored workspace's captures over separate seconds.
      this.nextCaptureAt = Date.now() + 1000;
      this.schedule();
    }
  }
}

export const parkedTerminalPool = new ParkedTerminalPool();
