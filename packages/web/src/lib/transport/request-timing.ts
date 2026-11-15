/**
 * End-to-end read cost, including the body. A browser sees localhost in SSH
 * mode, so navigator.connection cannot describe the link that matters here.
 * This only spaces background polls; it never delays input or explicit actions.
 */
export class RequestTiming {
  private duration = 0;
  private observedAt = -Infinity;
  private epoch = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  reset(): void {
    this.duration = 0;
    this.observedAt = -Infinity;
    this.epoch++;
  }

  start(): () => void {
    const started = this.now();
    const epoch = this.epoch;
    return () => {
      if (epoch !== this.epoch) return;
      const now = this.now();
      const elapsed = now - started;
      if (!Number.isFinite(elapsed) || elapsed < 0) return;
      if (now - this.observedAt > 60_000) this.duration = 0;
      // React promptly to congestion; recover gradually without oscillating.
      this.duration = Math.max(elapsed, this.duration * 0.75 + elapsed * 0.25);
      this.observedAt = now;
    };
  }

  interval(baseMs: number): number {
    if (this.now() - this.observedAt > 60_000) return baseMs;
    // Leave at least four request durations between polls, capped so routine
    // observations still recover. Preserve existing slower/heartbeat intervals.
    return Math.max(baseMs, Math.min(30_000, Math.ceil(this.duration * 4)));
  }
}

export const requestTiming = new RequestTiming();
