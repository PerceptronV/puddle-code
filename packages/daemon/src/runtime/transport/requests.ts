import type { RuntimeBufferBudget } from '../resources/budget.js';

/** Preserve one connection's ordering while charging queued work to its owner's shared budget. */
export class RuntimeRequestQueue {
  private tail: Promise<void> = Promise.resolve();
  constructor(
    private readonly budget: RuntimeBufferBudget,
    private readonly connected: () => boolean,
    private readonly failed: () => void,
  ) {}

  get settled(): Promise<void> {
    return this.tail;
  }

  enqueue(bytes: number, operation: () => Promise<void>): boolean {
    if (!this.connected()) return false;
    const release = this.budget.reserve(bytes);
    if (!release) return false;
    this.tail = this.tail
      .then(async () => {
        if (this.connected()) await operation();
      })
      .finally(release)
      .catch(this.failed);
    return true;
  }
}
