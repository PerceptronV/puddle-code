import { HostAdmission } from './admission.js';

const MAX_TASKS = 64;

/** Coalesced best-effort upkeep; never a queue for user mutations or agent commands. */
export class HostBackgroundTasks {
  private readonly admission = new HostAdmission();
  private readonly active = new Set<string>();

  /** Busy, paused or saturated upkeep waits for its next natural trigger, without replay. */
  start(key: string, action: () => Promise<unknown>): boolean {
    if (this.active.has(key) || this.active.size >= MAX_TASKS) return false;
    let release: () => void;
    try {
      release = this.admission.enter();
    } catch {
      return false;
    }
    this.active.add(key);
    void Promise.resolve()
      .then(action)
      .catch((error: unknown) => console.warn(`Background task ${key} failed:`, error))
      .finally(() => {
        this.active.delete(key);
        release();
      });
    return true;
  }

  /** One coalesced sweep with four workers, including hosts with more than 64 items. */
  startBatch<T>(key: string, items: readonly T[], action: (item: T) => Promise<unknown>): boolean {
    return this.start(key, async () => {
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, items.length) }, async () => {
          while (next < items.length) {
            const item = items[next++]!;
            try {
              await action(item);
            } catch (error) {
              console.warn(`Background task ${key} item failed:`, error);
            }
          }
        }),
      );
    });
  }

  pause(): ReturnType<HostAdmission['pause']> {
    return this.admission.pause();
  }

  beginShutdown(): void {
    this.admission.close();
  }

  async close(timeoutMs?: number): Promise<void> {
    this.beginShutdown();
    await this.admission.drain(timeoutMs);
  }
}
