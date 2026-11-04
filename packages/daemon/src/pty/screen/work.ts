import { RuntimeBufferBudget } from '../../runtime/resources/budget.js';
import { SCREEN_LIMITS } from './limits.js';

/** Only bounded metadata waiters: callers serialise after acquiring a slot. */
export class ScreenSnapshotWork {
  private readonly waiting: Array<(release: () => void) => void> = [];
  constructor(
    readonly budget = new RuntimeBufferBudget({
      bytes: SCREEN_LIMITS.transientBytes,
      count: SCREEN_LIMITS.transientOperations,
    }),
  ) {}

  tryAcquire(): (() => void) | null {
    const release = this.budget.reserve(SCREEN_LIMITS.operationBytes);
    if (!release) return null;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      release();
      const next = this.waiting.shift();
      if (next) {
        const reservation = this.tryAcquire();
        if (!reservation) throw new Error('Released screen work capacity was not available');
        next(reservation);
      }
    };
  }

  acquire(): Promise<() => void> {
    const release = this.tryAcquire();
    if (release) return Promise.resolve(release);
    if (this.waiting.length >= SCREEN_LIMITS.waitingOperations)
      return Promise.reject(new Error('Terminal snapshot work capacity exceeded'));
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}
